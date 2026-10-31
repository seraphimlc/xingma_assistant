import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuthContext } from '../../common/interfaces/auth-context.interface';
import { AuditService } from '../../common/audit.service';
import { MediaAsset } from '../../common/entities/media-asset.entity';
import { newId } from '../../common/utils/id';
import { ProductsService } from '../products.service';
import {
  buildPublishSuggestion,
  extractColorsFromText,
  extractMaterial,
  extractSizeText,
  extractStyleNo,
  normalizeColorList,
  parseBracketFields,
} from './publish-analyze';
import {
  ConfirmPublishInput,
  PublishBatch,
  PublishBatchAsset,
} from './publish.types';
import { PublishBatchStore } from './publish-batch.store';
import { JobsService } from '../../jobs/jobs.service';
import { buildJobDisplayTitle } from '../../jobs/job-display-title';
import { VisionClient } from '../../vision/vision.client';
import { OssClient } from '../../media/oss.client';
import { registerPublishProductHandler } from '../../jobs/handlers/publish-product.handler';
import { provisionalStyleNo, ocrImageText, isProvisionalStyleNo } from '../../vision/publish-vision';
import { LevelsService } from '../../levels/levels.service';
import { ProductGroupsService } from '../product-groups.service';

@Injectable()
export class PublishService implements OnModuleInit {
  private readonly batchStore = new PublishBatchStore(() => this.storageRoot());
  private readonly logger = new Logger('Publish');

  constructor(
    private readonly products: ProductsService,
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly vision: VisionClient,
    private readonly oss: OssClient,
    private readonly levels: LevelsService,
    private readonly groups: ProductGroupsService,
    private readonly audit: AuditService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit() {
    registerPublishProductHandler(this.jobs, this, this.vision);
  }

  private storageRoot() {
    return path.join(process.cwd(), 'storage');
  }

  private publicUrl(objectKey: string) {
    return this.oss.publicUrl(objectKey);
  }

  getBatch(tenantId: string, batchId: string): PublishBatch {
    this.batchStore.purgeExpiredMemory();
    const b = this.batchStore.get(tenantId, batchId);
    if (!b) throw new NotFoundException('发品批次不存在或已过期');
    return b;
  }

  /** 变更 assets/suggestion 后落盘，保证重启可恢复 */
  private persistBatch(batch: PublishBatch) {
    this.batchStore.save(batch);
  }

  /**
   * 上传一批无序图 → 落盘 media_assets + 内存 batch
   */
  async uploadBatch(
    user: AuthContext,
    files: Express.Multer.File[],
    existingBatchId?: string,
  ) {
    if (!files?.length) throw new BadRequestException('请至少上传一张图片');

    let batch: PublishBatch;
    if (existingBatchId) {
      batch = this.getBatch(user.tenantId, existingBatchId);
    } else {
      batch = {
        batchId: newId('batch'),
        tenantId: user.tenantId,
        createdAt: Date.now(),
        assets: [],
      };
      this.persistBatch(batch);
    }

    const uploadDir = path.join(
      this.storageRoot(),
      'tenants',
      user.tenantId,
      'uploads',
      batch.batchId,
    );
    fs.mkdirSync(uploadDir, { recursive: true });

    const added: PublishBatchAsset[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname || '') || this.extFromMime(file.mimetype) || '.jpg';
      const safeName = `${String(batch.assets.length + added.length + 1).padStart(2, '0')}_${Date.now()}${ext}`;
      const localPath = path.join(uploadDir, safeName);
      fs.writeFileSync(localPath, file.buffer);
      const objectKey = `tenants/${user.tenantId}/uploads/${batch.batchId}/${safeName}`;
      const mimeType = file.mimetype || 'image/jpeg';
      const url = await this.oss.putObjectSafe(file.buffer, objectKey, mimeType);
      const mediaId = await this.insertMediaAsset(user.tenantId, {
        objectKey,
        mimeType,
        sizeBytes: file.size || file.buffer.length,
      });
      const asset: PublishBatchAsset = {
        mediaId,
        objectKey,
        url,
        filename: file.originalname || safeName,
        mimeType,
        sizeBytes: file.size || file.buffer.length,
        localPath,
      };
      added.push(asset);
      this.logger.log(
        `upload batch=${batch.batchId} mediaId=${mediaId} size=${asset.sizeBytes} mime=${mimeType} objectKey=${objectKey}`,
      );
    }
    batch.assets.push(...added);
    batch.suggestion = undefined;
    this.persistBatch(batch);

    return {
      batchId: batch.batchId,
      assets: batch.assets.map((a) => ({
        mediaId: a.mediaId,
        url: a.url,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
      count: batch.assets.length,
    };
  }

  /**
   * 上传后立刻建草稿商品 + 异步任务，马上返回 productId/jobId。
   * 前端应立刻进编辑页，不干等 analyze。
   */
  async uploadAndEnqueue(
    user: AuthContext,
    files: Express.Multer.File[],
    body?: {
      batchId?: string;
      levelId?: string;
      status?: 'on_sale' | 'off_sale' | 'draft';
      priceDisplay?: 'show' | 'hide';
      styleNo?: string;
      name?: string;
    },
  ) {
    const uploaded = await this.uploadBatch(user, files || [], body?.batchId);
    return this.enqueueExistingBatch(user, uploaded.batchId, {
      ...body,
      levelId: body?.levelId,
      status: body?.status,
      priceDisplay: body?.priceDisplay,
      styleNo: body?.styleNo,
      name: body?.name,
    });
  }

  /**
   * 客户端已直传 OSS：用 objectKeys 建 batch（服务端拉回落盘供 OCR）→ 草稿 + 入队。
   * 不经 API 中转图片字节。
   */
  async registerFromOssKeysAndEnqueue(
    user: AuthContext,
    objectKeys: string[],
    body?: {
      levelId?: string;
      status?: string;
      priceDisplay?: string;
      styleNo?: string;
      name?: string;
      batchId?: string;
    },
  ) {
    if (!objectKeys?.length) throw new BadRequestException('请至少提供一个 objectKey');
    const tenantPrefix = `tenants/${user.tenantId}/`;
    const keys = [...new Set(objectKeys.map((k) => String(k || '').replace(/^\/+/, '')).filter(Boolean))];
    if (!keys.length) throw new BadRequestException('objectKeys 无效');
    for (const k of keys) {
      if (!k.startsWith(tenantPrefix)) {
        throw new BadRequestException(`对象不属于当前租户: ${k}`);
      }
    }

    let batch: PublishBatch;
    if (body?.batchId) {
      batch = this.getBatch(user.tenantId, body.batchId);
    } else {
      batch = {
        batchId: newId('batch'),
        tenantId: user.tenantId,
        createdAt: Date.now(),
        assets: [],
      };
      this.persistBatch(batch);
    }

    const uploadDir = path.join(
      this.storageRoot(),
      'tenants',
      user.tenantId,
      'uploads',
      batch.batchId,
    );
    fs.mkdirSync(uploadDir, { recursive: true });

    const added: PublishBatchAsset[] = [];
    for (let i = 0; i < keys.length; i++) {
      const objectKey = keys[i];
      // 已在本 batch 则跳过
      if (batch.assets.some((a) => a.objectKey === objectKey)) continue;

      let buffer: Buffer;
      try {
        buffer = await this.oss.getObjectBuffer(objectKey);
      } catch (e: any) {
        this.logger.warn(`from-oss get failed ${objectKey}: ${String(e?.message || e).slice(0, 160)}`);
        throw new BadRequestException(`无法读取已上传对象: ${path.basename(objectKey)}`);
      }
      const ext = path.extname(objectKey) || '.jpg';
      const safeName = `${String(batch.assets.length + added.length + 1).padStart(2, '0')}_${Date.now()}${ext}`;
      const localPath = path.join(uploadDir, safeName);
      fs.writeFileSync(localPath, buffer);
      const mimeType =
        ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      const url = this.oss.publicUrl(objectKey);
      const mediaId = await this.insertMediaAsset(user.tenantId, {
        objectKey,
        mimeType,
        sizeBytes: buffer.length,
      });
      const asset: PublishBatchAsset = {
        mediaId,
        objectKey,
        url,
        filename: path.basename(objectKey),
        mimeType,
        sizeBytes: buffer.length,
        localPath,
      };
      added.push(asset);
      this.logger.log(
        `from-oss batch=${batch.batchId} mediaId=${mediaId} size=${asset.sizeBytes} objectKey=${objectKey}`,
      );
    }
    batch.assets.push(...added);
    batch.suggestion = undefined;
    this.persistBatch(batch);

    if (!batch.assets.length) throw new BadRequestException('批次内无图片');

    return this.enqueueExistingBatch(user, batch.batchId, {
      levelId: body?.levelId,
      status: body?.status,
      priceDisplay: body?.priceDisplay,
      styleNo: body?.styleNo,
      name: body?.name,
    });
  }

  
  /** 解析可用商品等级：优先入参 → 环境默认 → open/OPEN → 列表首个 */
  private async resolveLevelId(tenantId: string, hint?: string): Promise<string> {
    const list = await this.levels.listProductLevels(tenantId);
    const prefer = String(hint || process.env.DEFAULT_PRODUCT_LEVEL_ID || '').trim();
    if (prefer && list.some((l) => l.id === prefer)) return prefer;
    const open = list.find((l) => {
      const code = String(l.code || '').toLowerCase();
      return code === 'open' || l.id === 'pl_open';
    });
    if (open) return open.id;
    if (list[0]) return list[0].id;
    // 自动建公开款，避免发品卡死
    const created = await this.levels.createProductLevel(tenantId, {
      code: 'OPEN',
      name: '公开款',
      rank: 0,
      defaultSharePolicy: 'open',
      minCustomerRank: null,
    });
    return created.id;
  }

  private async resolveGroupId(tenantId: string, hint?: string): Promise<string | null> {
    const prefer = String(hint || '').trim();
    if (prefer) return prefer;
    try {
      return await this.groups.getLatestGroupId(tenantId);
    } catch {
      return null;
    }
  }

  /** 对已有 batch：先落草稿商品再入队；返回 jobId + productId */
  async enqueueExistingBatch(
    user: AuthContext,
    batchId: string,
    body?: { levelId?: string; groupId?: string; status?: string; priceDisplay?: string; styleNo?: string; name?: string },
  ) {
    const batch = this.getBatch(user.tenantId, batchId);
    if (!batch.assets.length) throw new BadRequestException('批次内无图片');

    const statusIntent = (body?.status as 'on_sale' | 'off_sale' | 'draft') || 'on_sale';
    const levelId = await this.resolveLevelId(user.tenantId, body?.levelId);
    const groupId = await this.resolveGroupId(user.tenantId, body?.groupId);
    const priceDisplay = (body?.priceDisplay as 'show' | 'hide') || 'show';

    const draft = await this.createDraftProduct(user, batchId, {
      levelId,
      groupId,
      priceDisplay,
      styleNo: body?.styleNo,
      name: body?.name,
    });

    const mediaIds = batch.assets.map((a) => a.mediaId);
    const pubPayload = {
      batchId,
      productId: draft.id,
      levelId,
      groupId,
      status: statusIntent,
      statusIntent,
      priceDisplay,
      styleNo: body?.styleNo,
      draftStyleNo: draft.styleNo,
      name: body?.name,
      // 上传顺序；列表缩略图取首张，详情展示全部（识别失败后商品已丢弃仍可还原）
      mediaIds,
      sourceImageCount: mediaIds.length,
    };
    const job = await this.jobs.create(user, 'publish_product', {
      ...pubPayload,
      displayTitle: buildJobDisplayTitle('publish_product', pubPayload),
    });

    this.logger.log(
      `enqueue jobId=${job.id} productId=${draft.id} batchId=${batchId} statusIntent=${statusIntent}`,
    );

    return {
      jobId: job.id,
      productId: draft.id,
      batchId,
      count: batch.assets.length,
      job,
    };
  }

  /**
   * 入队时立刻落最小商品（status=off_sale），缺吊牌/款号/颜色也可进编辑页。
   */
  async createDraftProduct(
    user: AuthContext,
    batchId: string,
    opts: {
      levelId: string;
      groupId?: string | null;
      priceDisplay?: 'show' | 'hide';
      styleNo?: string;
      name?: string;
    },
  ) {
    const batch = this.getBatch(user.tenantId, batchId);
    if (!batch.assets.length) throw new BadRequestException('批次内无图片');

    let styleNo = String(opts.styleNo || '').trim();
    let styleNoProvisional = false;
    if (!styleNo) {
      styleNo = provisionalStyleNo(batchId);
      styleNoProvisional = true;
    }
    const name = String(opts.name || '').trim() || '待补信息';

    let coverMediaIds = await this.relocateBatchAssets(user, batch, styleNo);

    let product;
    try {
      product = await this.products.create(user, {
        styleNo,
        name,
        material: null,
        description: null,
        levelId: opts.levelId,
        groupId: opts.groupId ?? undefined,
        priceDisplay: opts.priceDisplay || 'show',
        status: 'off_sale',
        tags: ['待补信息', ...(styleNoProvisional ? ['provisionalStyleNo'] : [])],
        coverMediaIds,
        skus: [
          {
            color: '色1',
            size: null,
            price: null,
            stock: 0,
            status: 'active',
            skuCode: `${styleNo}-色1`,
          },
        ],
      });
    } catch (e) {
      if (e instanceof ConflictException && styleNoProvisional) {
        styleNo = provisionalStyleNo(batchId + String(Date.now()));
        coverMediaIds = await this.relocateBatchAssets(user, batch, styleNo);
        product = await this.products.create(user, {
          styleNo,
          name,
          material: null,
          description: null,
          levelId: opts.levelId,
          groupId: opts.groupId ?? undefined,
          priceDisplay: opts.priceDisplay || 'show',
          status: 'off_sale',
          tags: ['待补信息', 'provisionalStyleNo'],
          coverMediaIds,
          skus: [
            {
              color: '色1',
              size: null,
              price: null,
              stock: 0,
              status: 'active',
              skuCode: `${styleNo}-色1`,
            },
          ],
        });
      } else {
        throw e;
      }
    }

    for (const mid of coverMediaIds) {
      await this.updateMediaAsset(user.tenantId, mid, { productId: product.id });
    }

    this.logger.log(
      `createDraft productId=${product.id} batchId=${batchId} styleNo=${styleNo} provisional=${styleNoProvisional}`,
    );
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'publish.draft_create',
      targetType: 'product',
      targetId: product.id,
      detail: { batchId, styleNo, provisional: styleNoProvisional },
    });
    return product;
  }

  /**
   * 待补全：OCR 未识别出款号时保留商品（off_sale + needReview 标记），
   * 图集与封面保持可用，等用户在编辑页补录款号/颜色等信息。
   */
  async markPendingCompletion(
    user: AuthContext,
    input: {
      batchId: string;
      productId: string;
      name: string;
      material?: string | null;
      description?: string | null;
      levelId?: string;
      priceDisplay?: 'show' | 'hide';
      coverMediaIds?: string[];
      reviewReasons?: string[];
      failureReason?: string;
    },
  ) {
    const batch = this.getBatch(user.tenantId, input.batchId);
    const productId = input.productId;
    if (!productId) throw new BadRequestException('缺少 productId');

    const existing = await this.products.getDetail(user, productId);
    if (!existing) throw new NotFoundException('商品不存在');
    const tags = new Set<string>(((existing as any).tags as string[]) || []);
    tags.add('needReview');
    tags.add('待补信息');
    tags.add('provisionalStyleNo');
    for (const r of input.reviewReasons || []) tags.add(`review:${r}`);

    // 封面优先（识别结果），其余批次图保持原有顺序
    const batchIds = (batch.assets || []).map((a) => a.mediaId);
    const coverMediaIds = [...(input.coverMediaIds || []), ...batchIds]
      .filter(Boolean)
      .filter((id, i, arr) => arr.indexOf(id) === i);

    const product = await this.products.update(user, productId, {
      name: input.name?.trim() || '待补信息',
      material: input.material?.trim() || null,
      description: input.description || null,
      levelId: input.levelId,
      priceDisplay: input.priceDisplay || 'show',
      status: 'off_sale',
      tags: [...tags],
      coverMediaIds,
    } as any);

    this.batchStore.delete(batch.tenantId, batch.batchId);
    this.logger.log(
      `pendingCompletion productId=${productId} batchId=${input.batchId} ` +
        `reason=${input.failureReason || '-'} reviewReasons=${(input.reviewReasons || []).join(',') || '-'}`,
    );
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'publish.pending_completion',
      targetType: 'product',
      targetId: productId,
      detail: {
        batchId: input.batchId,
        reviewReasons: input.reviewReasons || [],
        failureReason: input.failureReason || null,
      },
    });
    return product;
  }

  /**
   * 待补全商品：上传单张吊牌图 OCR，返回建议字段（款号/颜色/材质/尺码）。
   * 传 productId 时吊牌图同时挂进商品图集。
   */
  async hangtagAnalyze(
    user: AuthContext,
    file: Express.Multer.File | undefined,
    body?: { productId?: string },
  ) {
    if (!file || !file.buffer?.length) throw new BadRequestException('请上传吊牌图片');
    const productId = String(body?.productId || '').trim();

    let styleDir: string | null = null;
    if (productId) {
      const detail = await this.products.getDetail(user, productId);
      if (!detail) throw new NotFoundException('商品不存在');
      styleDir = String((detail as any).styleNo || '').trim();
    }
    const ext = path.extname(file.originalname || '') || this.extFromMime(file.mimetype) || '.jpg';
    const stamp = Date.now();
    const relDir = styleDir
      ? `tenants/${user.tenantId}/products/${styleDir}`
      : `tenants/${user.tenantId}/hangtag`;
    const objectKey = `${relDir}/hangtag_${stamp}${ext}`;
    const localPath = path.join(this.storageRoot(), relDir, `hangtag_${stamp}${ext}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, file.buffer);
    const mimeType = file.mimetype || 'image/jpeg';
    const url = await this.oss.putObjectSafe(file.buffer, objectKey, mimeType);

    const ocr = await ocrImageText(this.vision, localPath, { hangtag: true });
    const text = String(ocr.text || '');
    const fields = parseBracketFields(text);
    let styleNo = extractStyleNo(text, []);
    if (styleNo && isProvisionalStyleNo(styleNo)) styleNo = '';
    const colors = normalizeColorList(extractColorsFromText(text));
    const material = extractMaterial(text, fields);
    const sizeText = extractSizeText(text, fields);
    const name =
      String(fields['品名'] || fields['款式'] || '').trim() ||
      (styleNo ? `款号 ${styleNo}` : '');

    let mediaId: string | null = null;
    if (productId) {
      mediaId = await this.insertMediaAsset(user.tenantId, {
        objectKey,
        mimeType,
        sizeBytes: file.size || file.buffer.length,
      });
      await this.updateMediaAsset(user.tenantId, mediaId, { productId });
      this.logger.log(`hangtagAnalyze attach productId=${productId} mediaId=${mediaId} ocr=${ocr.via}`);
    }

    return {
      styleNo: styleNo || null,
      name: name || null,
      colors,
      material: material || null,
      sizeText: sizeText || null,
      ocrNote: ocr.note || null,
      mediaId,
      url,
    };
  }

    async analyze(user: AuthContext, batchId: string, body?: { runOcr?: boolean }) {
    const batch = this.getBatch(user.tenantId, batchId);
    if (!batch.assets.length) throw new BadRequestException('批次内无图片');
    let suggestion;
    try {
      suggestion = await buildPublishSuggestion(batch.assets, {
        runOcr: body?.runOcr !== false,
        vision: this.vision,
        lookupByStyleNo: async (styleNo: string) => {
          const hit = await this.products.findByStyleNoWithColors(user.tenantId, styleNo);
          if (!hit?.colors?.length) return null;
          return {
            styleNo: hit.styleNo,
            colors: hit.colors,
            source: 'product' as const,
            name: hit.name,
            material: hit.material || undefined,
          };
        },
      });
    } catch (e: any) {
      // OCR/分析异常不得阻断建品草案
      this.logger.warn(`analyze soft-fail: ${String(e?.message || e).slice(0, 160)}`);
      suggestion = {
        styleNo: '',
        name: '新款羊毛衫',
        material: '',
        weight: '',
        sizeText: '',
        description: '',
        tags: [] as string[],
        colors: batch.assets.length >= 2 ? ['色1', '色2'] : ['色1'],
        colorSource: 'placeholder' as const,
        colorSourceNote: '分析异常，已占位（请编辑）',
        images: batch.assets.map((a, idx) => ({
          mediaId: a.mediaId,
          url: a.url,
          filename: a.filename,
          role: (idx === 0 ? 'main' : 'detail') as 'main' | 'detail',
          roleConfidence: 0.3,
          colorHint: null,
        })),
        skus: (batch.assets.length >= 2 ? ['色1', '色2'] : ['色1']).map((color) => ({
          color,
          price: null as string | null,
          mediaIds: [] as string[],
        })),
        ocrUsed: false,
        ocrNote: `分析异常已跳过: ${String(e?.message || e).slice(0, 100)}`,
      };
    }
    batch.suggestion = suggestion;
    this.persistBatch(batch);
    const colorSummary = (suggestion.colors || []).slice(0, 8).join('/') || '-';
    this.logger.log(
      `analyze batchId=${batchId} ocr=${suggestion.ocrUsed} via=${String(suggestion.ocrNote || '').slice(0, 80)} ` +
        `styleNo=${suggestion.styleNo || '-'} colors=${colorSummary} name=${String(suggestion.name || '').slice(0, 40)}`,
    );
    return {
      batchId,
      suggestion,
      assets: batch.assets.map((a) => ({
        mediaId: a.mediaId,
        url: a.url,
        filename: a.filename,
      })),
    };
  }

  /**
   * 异步任务完成后：更新已有草稿（封面/标题/SKU/material），按完成度设 status。
   * 不再二次 create。
   */
  async updateFromPublishJob(
    user: AuthContext,
    input: {
      batchId: string;
      productId: string;
      styleNo: string;
      name: string;
      material?: string | null;
      description?: string | null;
      levelId?: string;
      priceDisplay?: 'show' | 'hide';
      status: 'on_sale' | 'off_sale' | 'draft';
      tags?: string[];
      skus: Array<{ color: string; price?: string | null }>;
      images: Array<{ mediaId: string; role: string; colorHint?: string | null }>;
      coverMediaIds?: string[];
      needReview?: boolean;
      reviewReasons?: string[];
    },
  ) {
    const batch = this.getBatch(user.tenantId, input.batchId);
    const productId = input.productId;
    if (!productId) throw new BadRequestException('缺少 productId');
    if (!input.styleNo?.trim()) throw new BadRequestException('款号必填');
    if (!input.name?.trim()) throw new BadRequestException('名称必填');
    if (!input.skus?.length) throw new BadRequestException('至少保留一个颜色 SKU');

    const styleNo = input.styleNo.trim();
    const coverMediaIds = await this.relocateBatchAssets(
      user,
      batch,
      styleNo,
      input.coverMediaIds || input.images?.map((i) => i.mediaId),
    );

    const sizeText =
      batch.suggestion?.sizeText ||
      (input.description || '').match(/尺码[：:]\s*(.+)/)?.[1] ||
      '';
    let description = (input.description || '').trim();
    if (sizeText && !description.includes('尺码')) {
      description = description ? `${description}\n尺码：${sizeText}` : `尺码：${sizeText}`;
    }

    const tags = [...(input.tags || [])].filter((t) => t && t !== '识别中' && t !== '待补信息');
    if (input.needReview && !tags.includes('needReview')) tags.push('needReview');
    if (!input.needReview) {
      const idx = tags.indexOf('needReview');
      if (idx >= 0) tags.splice(idx, 1);
      const pIdx = tags.indexOf('provisionalStyleNo');
      if (pIdx >= 0) tags.splice(pIdx, 1);
    }
    for (const r of input.reviewReasons || []) {
      const tag = `review:${r}`;
      if (!tags.includes(tag)) tags.push(tag);
    }

    try {
      await this.products.update(user, productId, {
        styleNo,
        name: input.name.trim(),
        material: input.material?.trim() || null,
        description: description || null,
        levelId: input.levelId,
        priceDisplay: input.priceDisplay || 'show',
        status: input.status,
        tags,
        coverMediaIds,
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        // 识别款号与已有商品冲突：保留当前款号，强制下架 + needReview（无草稿态）
        this.logger.warn(
          `updateFromPublishJob styleNo conflict productId=${productId} wanted=${styleNo}`,
        );
        if (!tags.includes('needReview')) tags.push('needReview');
        if (!tags.includes('review:style_no_conflict')) tags.push('review:style_no_conflict');
        await this.products.update(user, productId, {
          name: input.name.trim(),
          material: input.material?.trim() || null,
          description: description || null,
          levelId: input.levelId,
          priceDisplay: input.priceDisplay || 'show',
          status: 'off_sale',
          tags,
          coverMediaIds,
        });
      } else {
        throw e;
      }
    }

    await this.products.replaceColorSkus(user, productId, input.skus);

    for (const mid of coverMediaIds) {
      await this.updateMediaAsset(user.tenantId, mid, { productId });
    }

    this.batchStore.delete(batch.tenantId, batch.batchId);
    this.logger.log(
      `updateFromPublishJob productId=${productId} batchId=${input.batchId} ` +
        `status=${input.status} needReview=${!!input.needReview} reasons=${(input.reviewReasons || []).join(',') || '-'}`,
    );

    // 返回最新（含 SKU）
    return this.products.getDetail(user, productId);
  }

  /** 将 batch 图挪到 products/{styleNo}/，返回最终 coverMediaIds 顺序 */
  private async relocateBatchAssets(
    user: AuthContext,
    batch: PublishBatch,
    styleNo: string,
    preferredOrder?: string[],
  ): Promise<string[]> {
    const destDir = path.join(this.storageRoot(), 'tenants', user.tenantId, 'products', styleNo);
    fs.mkdirSync(destDir, { recursive: true });

    const orderIds =
      preferredOrder?.filter((id) => batch.assets.some((a) => a.mediaId === id)) ||
      batch.assets.map((a) => a.mediaId);
    for (const a of batch.assets) {
      if (!orderIds.includes(a.mediaId)) orderIds.push(a.mediaId);
    }

    const coverMediaIds: string[] = [];
    let idx = 0;
    for (const mediaId of orderIds) {
      const asset = batch.assets.find((a) => a.mediaId === mediaId);
      if (!asset) continue;
      idx += 1;
      const ext = path.extname(asset.localPath) || '.jpg';
      const destName = `${String(idx).padStart(2, '0')}${ext}`;
      const destPath = path.join(destDir, destName);
      if (fs.existsSync(asset.localPath) && path.resolve(asset.localPath) !== path.resolve(destPath)) {
        fs.copyFileSync(asset.localPath, destPath);
      } else if (!fs.existsSync(destPath) && fs.existsSync(asset.localPath)) {
        fs.copyFileSync(asset.localPath, destPath);
      }
      const newKey = `tenants/${user.tenantId}/products/${styleNo}/${destName}`;
      if (fs.existsSync(destPath)) {
        asset.url = await this.oss.putObjectSafe(
          fs.readFileSync(destPath),
          newKey,
          asset.mimeType || 'image/jpeg',
        );
      } else {
        asset.url = this.publicUrl(newKey);
      }
      await this.updateMediaAsset(user.tenantId, asset.mediaId, {
        objectKey: newKey,
        sizeBytes: fs.existsSync(destPath) ? fs.statSync(destPath).size : asset.sizeBytes,
      });
      asset.objectKey = newKey;
      asset.localPath = destPath;
      coverMediaIds.push(asset.mediaId);
    }
    this.persistBatch(batch);
    return coverMediaIds;
  }

  /**
   * 确认发品：创建 Product + 颜色 SKU（size=null）+ 挂图
   */
  async confirm(user: AuthContext, input: ConfirmPublishInput) {
    const batch = this.getBatch(user.tenantId, input.batchId);
    if (!input.styleNo?.trim()) throw new BadRequestException('款号必填');
    if (!input.name?.trim()) throw new BadRequestException('名称必填');
    if (!input.levelId) throw new BadRequestException('商品等级必填');
    if (!input.skus?.length) throw new BadRequestException('至少保留一个颜色 SKU');

    const colors = input.skus.map((s) => (s.color || '').trim()).filter(Boolean);
    if (!colors.length) throw new BadRequestException('颜色名不能为空');
    if (new Set(colors).size !== colors.length) {
      throw new BadRequestException('颜色名不能重复');
    }

    const mediaIds = input.images?.map((i) => i.mediaId) || batch.assets.map((a) => a.mediaId);
    const validSet = new Set(batch.assets.map((a) => a.mediaId));
    for (const id of mediaIds) {
      if (!validSet.has(id)) throw new BadRequestException(`图片不在本批次: ${id}`);
    }

    // 将 uploads 下文件挪到 products/{styleNo}/
    const styleNo = input.styleNo.trim();
    const destDir = path.join(this.storageRoot(), 'tenants', user.tenantId, 'products', styleNo);
    fs.mkdirSync(destDir, { recursive: true });

    const coverMediaIds: string[] = [];
    // 默认展示序：挂拍/主图 → 细节 → 场景/模特 → 吊牌/文字类（封面由 vision 再置顶）
    const roleOrder = ['main', 'multi_color', 'detail', 'on_model', 'packaging', 'unknown', 'size_chart', 'lab_report', 'hangtag'];
    const ordered = [...(input.images || [])].sort((a, b) => {
      const ia = roleOrder.indexOf(a.role);
      const ib = roleOrder.indexOf(b.role);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const seq =
      ordered.length > 0
        ? ordered
        : batch.assets.map((a) => ({ mediaId: a.mediaId, role: 'main' as const }));

    let idx = 0;
    for (const im of seq) {
      const asset = batch.assets.find((a) => a.mediaId === im.mediaId);
      if (!asset) continue;
      idx += 1;
      const ext = path.extname(asset.localPath) || '.jpg';
      const destName = `${String(idx).padStart(2, '0')}${ext}`;
      const destPath = path.join(destDir, destName);
      if (fs.existsSync(asset.localPath)) {
        fs.copyFileSync(asset.localPath, destPath);
      }
      const newKey = `tenants/${user.tenantId}/products/${styleNo}/${destName}`;
      if (fs.existsSync(destPath)) {
        asset.url = await this.oss.putObjectSafe(
          fs.readFileSync(destPath),
          newKey,
          asset.mimeType || 'image/jpeg',
        );
      } else {
        asset.url = this.publicUrl(newKey);
      }
      await this.updateMediaAsset(user.tenantId, asset.mediaId, {
        objectKey: newKey,
        productId: null, // 创建后再绑
        sizeBytes: fs.existsSync(destPath) ? fs.statSync(destPath).size : asset.sizeBytes,
      });
      asset.objectKey = newKey;
      asset.localPath = destPath;
      coverMediaIds.push(asset.mediaId);
    }

    const finalCovers =
      input.coverMediaIds?.filter((id) => coverMediaIds.includes(id)) || coverMediaIds;

    const sizeText =
      batch.suggestion?.sizeText ||
      (input.description || '').match(/尺码[：:]\s*(.+)/)?.[1] ||
      '';
    let description = (input.description || '').trim();
    if (sizeText && !description.includes('尺码')) {
      description = description ? `${description}\n尺码：${sizeText}` : `尺码：${sizeText}`;
    }

    const skus = input.skus.map((s) => ({
      color: s.color.trim(),
      size: null as null,
      price: s.price != null && String(s.price).trim() !== '' ? String(s.price).trim() : null,
      stock: 0,
      status: 'active',
      skuCode: `${styleNo}-${s.color.trim()}`,
    }));

    let product;
    try {
      const levelId = await this.resolveLevelId(user.tenantId, input.levelId);
      const groupId = await this.resolveGroupId(user.tenantId, (input as any).groupId);
      product = await this.products.create(user, {
        styleNo,
        name: input.name.trim(),
        material: input.material?.trim() || null,
        description: description || null,
        levelId,
        groupId: groupId ?? undefined,
        priceDisplay: input.priceDisplay || 'show',
        status: input.status || 'on_sale',
        tags: input.tags || batch.suggestion?.tags || [],
        coverMediaIds: finalCovers,
        skus,
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }

    // 绑定 media.product_id
    for (const mid of finalCovers) {
      await this.updateMediaAsset(user.tenantId, mid, { productId: product.id });
    }

    this.batchStore.delete(batch.tenantId, batch.batchId);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'publish.confirm',
      targetType: 'product',
      targetId: product.id,
      detail: { batchId: input.batchId, styleNo: input.styleNo?.trim(), status: input.status || 'on_sale', coverCount: finalCovers.length },
    });
    return product;
  }

  private extFromMime(mime?: string) {
    if (!mime) return '.jpg';
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
  }

  private async insertMediaAsset(
    tenantId: string,
    data: { objectKey: string; mimeType: string; sizeBytes: number },
  ): Promise<string> {
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      const repo = this.dataSource.getRepository(MediaAsset);
      const row = repo.create({
        tenantId,
        productId: null,
        type: 'image',
        provider: this.oss.mediaProvider(),
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        sizeBytes: String(data.sizeBytes),
        status: 'active',
      });
      const saved = await repo.save(row);
      return saved.id;
    }
    return newId();
  }

  private async updateMediaAsset(
    tenantId: string,
    mediaId: string,
    patch: { objectKey?: string; productId?: string | null; sizeBytes?: number },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return;
    const repo = this.dataSource.getRepository(MediaAsset);
    const row = await repo.findOne({ where: { id: mediaId, tenantId } });
    if (!row) return;
    if (patch.objectKey !== undefined) row.objectKey = patch.objectKey;
    if ('productId' in patch) row.productId = patch.productId ?? null;
    if (patch.sizeBytes !== undefined) row.sizeBytes = String(patch.sizeBytes);
    await repo.save(row);
  }
}
