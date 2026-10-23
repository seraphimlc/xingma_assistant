import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { MediaAsset } from '../common/entities/media-asset.entity';
import { PromoSetEntity, PromoSetImage } from '../common/entities/promo-set.entity';
import { newId } from '../common/utils/id';
import { ProductsService } from '../products/products.service';
import { ImageGenClient } from './image-gen.client';
import { MODELS, SIZES, TEMPLATES, findTemplate, templateDto, resolveOption, buildStyleRefPrompt, StyleStrength, isVideoTemplate, listTemplatesByKind } from './promo.templates';
import { enrichPoseSceneText } from './pose-scene-enrich';
import { VisionClient } from '../vision/vision.client';
import { JobsService } from '../jobs/jobs.service';
import { registerPromoImageHandler } from '../jobs/handlers/promo-image.handler';
import { registerPromoVideoHandler } from '../jobs/handlers/promo-video.handler';
import { JobProgress } from '../jobs/job.types';
import { OssClient } from '../media/oss.client';
import { buildPromoCaption } from './promo.captions';
import { buildJobDisplayTitle } from '../jobs/job-display-title';
import { VideoGenClient } from './video-gen.client';

export interface GenerateInput {
  templateId: string;
  /** image（默认）| video：走 promo_image / promo_video */
  mediaKind?: 'image' | 'video';
  feature?: string;
  referenceAssetIds: string[];
  modelId?: string | null;
  poses?: string[];
  scenes?: string[];
  /** 用户自由描述姿势/呈现；可与 poses 并存，优先写入 prompt */
  poseText?: string;
  /** 用户自由描述场景/背景 */
  sceneText?: string;
  colors?: string[];
  count?: number;
  sizeId?: string;
  /** 已有宣传图组：整组/单张重生成时传入 */
  setId?: string;
  /** 仅重生成这些下标；缺省则整组 */
  regenIndexes?: number[];
  /**
   * 风格样例 OSS objectKey（业务 key，无 OSS_PREFIX）。
   * 0～4；须 tenants/{tenantId}/promo_style_ref/ 前缀；不写 coverMediaIds。
   */
  styleRefObjectKeys?: string[];
  /** 风格强弱：weak / medium / strong；默认 medium；无风格图时忽略 */
  styleStrength?: StyleStrength;
  /** 视频时长秒数（约 15）；仅 mediaKind=video */
  seconds?: number;
}

interface JobItem {
  index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  prompt: string;
  poseId?: string;
  sceneId?: string;
  objectKey?: string;
  url?: string;
  via?: string;
  error?: string;
  savedMediaId?: string;
  ms?: number;
}
interface PromoJob {
  id: string;
  tenantId: string;
  productId: string;
  templateId: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  input: GenerateInput;
  size: string;
  items: JobItem[];
  createdAt: number;
  updatedAt: number;
}

/** 全局上游并发上限 */
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.IMAGE_GEN_CONCURRENCY || '2', 10));

@Injectable()
export class PromoService implements OnModuleInit {
  private readonly logger = new Logger('Promo');
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly products: ProductsService,
    private readonly gen: ImageGenClient,
    private readonly videoGen: VideoGenClient,
    private readonly jobs: JobsService,
    private readonly oss: OssClient,
    @Optional() private readonly vision?: VisionClient,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit() {
    registerPromoImageHandler(this.jobs, this);
    registerPromoVideoHandler(this.jobs, this);
  }

  // ---------- 路径 ----------
  private storageRoot() {
    return path.join(process.cwd(), 'storage');
  }
  /** 状态 JSON 不放在 /media 静态目录下 */
  private stateDir(tenantId: string, productId: string) {
    const d = path.join(process.cwd(), 'data', 'promo', tenantId, productId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  private publicUrl(objectKey: string) {
    return this.oss.publicUrl(objectKey);
  }

  /** 校验并规范化风格样例 keys；空/缺省 → [] */
  private normalizeStyleRefs(user: AuthContext, keys: unknown): string[] {
    if (keys == null || keys === undefined) return [];
    if (!Array.isArray(keys)) throw new BadRequestException('styleRefObjectKeys 须为数组');
    const arr = keys.map((k) => String(k || '').trim()).filter(Boolean);
    if (arr.length > 4) throw new BadRequestException('风格样例最多 4 张');
    const prefix = `tenants/${user.tenantId}/promo_style_ref/`;
    const okExt = /\.(jpe?g|png|webp)$/i;
    for (const k of arr) {
      if (k.includes('..') || k.includes('\\') || k.startsWith('/')) {
        throw new BadRequestException('风格样例路径不合法');
      }
      if (!k.startsWith(prefix)) {
        throw new BadRequestException('风格样例不属于当前租户或不合法');
      }
      if (!okExt.test(k)) {
        throw new BadRequestException('风格样例仅支持 jpg/png/webp');
      }
    }
    return arr;
  }

  private normalizeStyleStrength(v: unknown): StyleStrength {
    if (v == null || v === '' || v === undefined) return 'medium';
    const s = String(v);
    if (s === 'weak' || s === 'medium' || s === 'strong') return s;
    throw new BadRequestException('styleStrength 须为 weak / medium / strong');
  }

  /**
   * 确保 objectKey 在本地 storage/ 可读；缺则从 OSS 拉取。
   * 失败返回 null（调用方决定降级或报错）。
   */
  private async ensureLocal(objectKey: string): Promise<string | null> {
    const abs = path.join(this.storageRoot(), objectKey);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    } catch {
      /* fall through to download */
    }
    try {
      const buf = await this.oss.getObjectBuffer(objectKey);
      if (!buf?.length) return null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return abs;
    } catch (e: any) {
      // 本地 mock / 无 OSS：若文件本就该在 storage，再探一次
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
      } catch {
        /* ignore */
      }
      this.logger.warn(`ensureLocal fail key=${objectKey}: ${e?.message || e}`);
      return null;
    }
  }

  // ---------- 预设 ----------
  listTemplates(kind: 'image' | 'video' | 'all' = 'image') {
    return listTemplatesByKind(kind).map(templateDto);
  }
  listModels() {
    return MODELS.map(({ id, name, desc }) => ({ id, name, desc }));
  }
  presets() {
    return {
      templates: this.listTemplates('image'),
      videoTemplates: this.listTemplates('video'),
      models: this.listModels(),
      sizes: Object.values(SIZES),
    };
  }

  // ---------- 素材 ----------
  private async productAssets(user: AuthContext, productId: string) {
    const product: any = await this.products.getDetail(user, productId);
    let assets: Array<{ id: string; objectKey: string }> = [];
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      const rows = await this.dataSource
        .getRepository(MediaAsset)
        .find({ where: { tenantId: user.tenantId, productId, status: 'active', type: 'image' } });
      const order: string[] = product.coverMediaIds || [];
      rows.sort((a, b) => {
        const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.objectKey.localeCompare(b.objectKey);
      });
      assets = rows.map((r) => ({ id: r.id, objectKey: r.objectKey }));
    }
    return { product, assets };
  }

  private defaultFeature(p: any) {
    const colors = [...new Set((p.skus || []).map((s: any) => s.color).filter(Boolean))];
    return [
      p.name && `品名：${p.name}`,
      p.styleNo && `款号：${p.styleNo}`,
      p.material && `材质：${p.material}`,
      colors.length && `颜色：${colors.join('、')}`,
      p.description && `描述：${String(p.description).slice(0, 300)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async start(user: AuthContext, productId: string, body: { templateId?: string }) {
    const { product, assets } = await this.productAssets(user, productId);
    const draft = this.readFeature(user.tenantId, productId);
    const feature = draft?.feature || this.defaultFeature(product);
    const tpl = body?.templateId ? findTemplate(body.templateId) : null;
    return {
      product: { id: product.id, styleNo: product.styleNo, name: product.name },
      colors: [...new Set((product.skus || []).map((s: any) => s.color).filter(Boolean))],
      assets: assets.map((a, i) => ({
        id: a.id,
        url: this.publicUrl(a.objectKey),
        isCover: i < (product.coverMediaIds || []).length,
        isPromo: a.objectKey.includes('/promo/'),
      })),
      feature,
      featureSource: draft ? 'saved' : 'auto',
      template: tpl ? templateDto(tpl) : null,
      configured: this.gen.configured(),
      videoConfigured: this.videoGen.configured(),
    };
  }

  private readFeature(tenantId: string, productId: string): { feature: string } | null {
    const f = path.join(this.stateDir(tenantId, productId), 'feature.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  async getFeature(user: AuthContext, productId: string) {
    const { product } = await this.productAssets(user, productId);
    const d = this.readFeature(user.tenantId, productId);
    return { feature: d?.feature || this.defaultFeature(product), source: d ? 'saved' : 'auto' };
  }
  async putFeature(user: AuthContext, productId: string, body: { feature: string }) {
    await this.products.getDetail(user, productId);
    const feature = String(body?.feature || '').slice(0, 2000);
    fs.writeFileSync(
      path.join(this.stateDir(user.tenantId, productId), 'feature.json'),
      JSON.stringify({ feature, updatedAt: Date.now() }),
    );
    return { feature, source: 'saved' };
  }

  // ---------- 生成 ----------
  private setsRepo() {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('宣传图组需要 DB_ENABLED=true');
    }
    return this.dataSource.getRepository(PromoSetEntity);
  }

  private captionFor(product: any, input: GenerateInput, tplId: string) {
    const tpl = findTemplate(tplId);
    const model = MODELS.find((m) => m.id === input.modelId);
    const poses = (tpl?.poses || []).filter((o) => (input.poses || []).includes(o.id)).map((o) => o.name);
    const scenes = (tpl?.scenes || []).filter((o) => (input.scenes || []).includes(o.id)).map((o) => o.name);
    return buildPromoCaption({
      templateId: tplId,
      product,
      colors: input.colors,
      feature: input.feature,
      modelName: model?.name,
      poseNames: poses,
      sceneNames: scenes,
    });
  }

  async generate(user: AuthContext, productId: string, input: GenerateInput) {
    const tpl = findTemplate(input?.templateId);
    if (!tpl) throw new BadRequestException('未知模板');
    const wantVideo =
      input?.mediaKind === 'video' || isVideoTemplate(tpl) || String(input?.mediaKind || '') === 'promo_video';
    if (wantVideo) {
      return this.generateVideo(user, productId, { ...input, mediaKind: 'video', templateId: tpl.id });
    }
    if (!this.gen.configured()) throw new BadRequestException('服务端未配置生图密钥');
    const product: any = await this.products.getDetail(user, productId);
    const colorsIn = Array.isArray(input.colors) ? input.colors.map((c) => String(c || '').trim()).filter(Boolean) : [];
    let count: number;
    if (tpl.id === 'multi_color') {
      const n = colorsIn.length;
      if (n < tpl.count.min) throw new BadRequestException(`多色展示至少选择 ${tpl.count.min} 个颜色`);
      if (n > tpl.count.max) throw new BadRequestException(`多色展示最多 ${tpl.count.max} 个颜色`);
      const refs = (input.referenceAssetIds || []).filter(Boolean);
      if (refs.length !== n) {
        throw new BadRequestException(`多色展示需每个颜色 1 张参考图（已选 ${n} 色 / ${refs.length} 张图）`);
      }
      if (tpl.model === 'required' && !input.modelId) {
        throw new BadRequestException('多色展示需要选择模特');
      }
      count = n;
    } else {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, Number(input.count) || tpl.count.default));
    }
    const styleRefObjectKeys = this.normalizeStyleRefs(user, input.styleRefObjectKeys);
    const styleStrength = this.normalizeStyleStrength(input.styleStrength);
    const caption = this.captionFor(product, { ...input, colors: colorsIn.length ? colorsIn : input.colors, count }, tpl.id);
    const params = {
      templateId: tpl.id,
      feature: input.feature || '',
      referenceAssetIds: input.referenceAssetIds || [],
      modelId: input.modelId || null,
      // multi_color：整组共用同一姿态/场景（只取首个）
      poses: tpl.id === 'multi_color' ? (input.poses || []).slice(0, 1) : (input.poses || []),
      scenes: tpl.id === 'multi_color' ? (input.scenes || []).slice(0, 1) : (input.scenes || []),
      poseText: String(input.poseText || '').trim() || undefined,
      sceneText: String(input.sceneText || '').trim() || undefined,
      colors: tpl.id === 'multi_color' ? colorsIn : (input.colors || []),
      count,
      sizeId: input.sizeId || tpl.defaultSize,
      // 风格样例整组共用（含 multi_color）；空数组不写也等价现网
      styleRefObjectKeys,
      styleStrength: styleRefObjectKeys.length ? styleStrength : undefined,
    };

    const isPartialRegen = Array.isArray(input.regenIndexes) && input.regenIndexes.length > 0;
    const isExplicitSetRegen = !!String(input.setId || '').trim();
    const repo = this.setsRepo();

    // 仅「全新生成」防重复提交；已有 set 的重生必须重新排队（不可静默返回进行中 job）
    if (!isPartialRegen && !isExplicitSetRegen) {
      const reused = await this.findActivePromo(user, productId, tpl.id, input.setId);
      if (reused) {
        this.logger.log(
          `generate reuse productId=${productId} templateId=${tpl.id} setId=${reused.setId} jobId=${reused.jobId}`,
        );
        return reused;
      }
    }

    let setId = input.setId;
    let existingJobId: string | null = null;
    if (setId) {
      const existing = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (!existing) throw new NotFoundException('宣传图组不存在');
      existing.status = 'generating';
      existing.params = params;
      existing.caption = caption;
      existing.templateId = tpl.id;
      // 局部重生：目标槽位标 pending，列表立刻显示「生成中」占位；整组则全部 pending
      const regenIdx = isPartialRegen
        ? new Set((input.regenIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))
        : null;
      const prevImages = Array.isArray(existing.images) ? existing.images : [];
      if (prevImages.length) {
        existing.images = prevImages.map((img) => {
          const shouldPending = !regenIdx || regenIdx.has(Number(img.index));
          if (!shouldPending) return img;
          return {
            ...img,
            status: 'pending' as const,
            error: undefined,
            ms: undefined,
          };
        });
      } else if (!isPartialRegen) {
        existing.images = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const }));
      }
      existingJobId = existing.jobId || null;
      await repo.save(existing);
    } else {
      setId = newId('ps');
      await repo.save(
        repo.create({
          id: setId,
          tenantId: user.tenantId,
          productId,
          templateId: tpl.id,
          params,
          caption,
          jobId: null,
          legacyJobId: null,
          status: 'generating',
          images: Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const })),
        }),
      );
    }

    const jobPayload = {
      productId,
      setId,
      ...params,
      styleNo: product.styleNo,
      regenIndexes: input.regenIndexes,
    };
    // multi_color 不写入易错的场景模特 displayTitle，由 buildJobDisplayTitle 现算
    const displayTitle = buildJobDisplayTitle('promo_image', { ...jobPayload, displayTitle: undefined });
    // 重生：复用该组已有 job，不在任务中心新开一行
    const job = await this.jobs.reuseOrCreate(
      user,
      'promo_image',
      { ...jobPayload, displayTitle },
      { existingJobId },
    );
    try {
      await this.jobs.cancelSiblingPromoJobs(user, {
        setId,
        exceptJobId: job.id,
        types: ['promo_image'],
      });
    } catch (e: any) {
      this.logger.warn(`cancelSiblingPromoJobs: ${e?.message || e}`);
    }
    await repo.update({ id: setId, tenantId: user.tenantId }, { jobId: job.id });

    return {
      id: job.id,
      jobId: job.id,
      setId,
      status: job.status,
      templateId: tpl.id,
      caption,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      done: 0,
      total: count,
      items: [],
      reused: false,
    };
  }


  /**
   * 宣传视频：创建 promo_sets(kind=video) + jobs(type=promo_video)。
   * 一期固定 1 条竖屏约 15s；模板默认 product_showcase_video。
   */
  async generateVideo(user: AuthContext, productId: string, input: GenerateInput) {
    let tpl = findTemplate(input?.templateId);
    if (!tpl || !isVideoTemplate(tpl)) {
      tpl = findTemplate('product_showcase_video') || undefined;
    }
    if (!tpl) throw new BadRequestException('未知视频模板');
    if (!this.videoGen.configured()) throw new BadRequestException('服务端未配置视频生成密钥');
    const product: any = await this.products.getDetail(user, productId);
    const refs = (input.referenceAssetIds || []).filter(Boolean);
    if (refs.length < tpl.reference.min || refs.length > tpl.reference.max) {
      throw new BadRequestException(`视频需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    const count = 1;
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    const feature = String(input.feature || '').slice(0, 2000);
    const caption = this.captionFor(product, { ...input, feature, count, sizeId }, tpl.id);
    const params = {
      kind: 'video' as const,
      mediaKind: 'video' as const,
      templateId: tpl.id,
      feature,
      referenceAssetIds: refs,
      modelId: null,
      poses: [],
      scenes: [],
      colors: [],
      count,
      sizeId,
      seconds: parseInt(process.env.VIDEO_GEN_SECONDS || '15', 10) || 15,
    };

    const repo = this.setsRepo();
    const reused = await this.findActivePromo(user, productId, tpl.id, input.setId, 'promo_video');
    if (reused) {
      this.logger.log(
        `generateVideo reuse productId=${productId} templateId=${tpl.id} setId=${reused.setId} jobId=${reused.jobId}`,
      );
      return reused;
    }

    let setId = input.setId;
    if (setId) {
      const existing = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (!existing) throw new NotFoundException('宣传素材组不存在');
      existing.status = 'generating';
      existing.params = params;
      existing.caption = caption;
      existing.templateId = tpl.id;
      await repo.save(existing);
    } else {
      setId = newId('ps');
      await repo.save(
        repo.create({
          id: setId,
          tenantId: user.tenantId,
          productId,
          templateId: tpl.id,
          params,
          caption,
          jobId: null,
          legacyJobId: null,
          status: 'generating',
          images: [{ index: 0, status: 'pending' as const }],
        }),
      );
    }

    const jobPayload = {
      productId,
      setId,
      ...params,
      styleNo: product.styleNo,
    };
    const displayTitle = buildJobDisplayTitle('promo_video', { ...jobPayload, displayTitle: undefined });
    const job = await this.jobs.create(user, 'promo_video', {
      ...jobPayload,
      displayTitle,
    });
    await repo.update({ id: setId, tenantId: user.tenantId }, { jobId: job.id });

    return {
      id: job.id,
      jobId: job.id,
      setId,
      status: job.status,
      templateId: tpl.id,
      kind: 'video',
      mediaKind: 'video',
      caption,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      done: 0,
      total: count,
      items: [],
      reused: false,
    };
  }

  /**
   * promo_video worker：生成单条视频 → OSS → promo_sets / media_assets(type=video)。
   */
  async executeGenerateVideoJob(
    user: AuthContext,
    productId: string,
    input: GenerateInput & Record<string, unknown>,
    opts?: { onProgress?: (p: Partial<JobProgress>) => Promise<void> },
  ) {
    let tpl = findTemplate(String(input?.templateId || ''));
    if (!tpl || !isVideoTemplate(tpl)) tpl = findTemplate('product_showcase_video') || undefined;
    if (!tpl) throw new Error('未知视频模板');
    if (!this.videoGen.configured()) throw new Error('服务端未配置视频生成密钥');

    const { product, assets } = await this.productAssets(user, productId);
    const refIds = ((input.referenceAssetIds as string[]) || []).filter(Boolean);
    if (refIds.length < tpl.reference.min || refIds.length > tpl.reference.max) {
      throw new Error(`视频需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    const byId = new Map(assets.map((a) => [a.id, a]));
    const refs = refIds.map((id) => byId.get(id));
    if (refs.some((r) => !r)) throw new Error('参考图不属于该商品');

    const feature = String(
      input.feature ?? this.readFeature(user.tenantId, productId)?.feature ?? this.defaultFeature(product),
    ).slice(0, 2000);
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    const upstreamSize = SIZES[sizeId]?.upstream || this.videoGen.defaultSize;
    const seconds = Number(input.seconds ?? process.env.VIDEO_GEN_SECONDS ?? 15) || 15;
    const prompt = tpl.buildPrompt({
      feature,
      model: null,
      pose: null,
      scene: null,
      colors: [],
      index: 0,
      total: 1,
    });

    await opts?.onProgress?.({ percent: 10, step: 'refs', message: '准备参考图', done: 0, total: 1 });

    const refPaths: string[] = [];
    for (const r of refs) {
      const local = await this.ensureLocal(r!.objectKey);
      if (!local) throw new Error(`参考图本地不可用：${r!.objectKey}`);
      refPaths.push(local);
    }

    const legacyId = newId('pj');
    const keyDir = `tenants/${user.tenantId}/products/${product.styleNo}/promo/${legacyId}`;
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });

    const setId = String(input.setId || '');
    const item: JobItem = { index: 0, status: 'running', prompt };
    const legacy: PromoJob = {
      id: legacyId,
      tenantId: user.tenantId,
      productId,
      templateId: tpl.id,
      status: 'running',
      input: {
        ...(input as GenerateInput),
        mediaKind: 'video',
        feature,
        count: 1,
        sizeId,
        _frameworkJobId: String(input._frameworkJobId || ''),
      } as any,
      size: upstreamSize,
      items: [item],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveJob(legacy);

    await opts?.onProgress?.({ percent: 20, step: 'generating', message: '视频生成中', done: 0, total: 1 });
    const t0 = Date.now();
    try {
      const r = await this.videoGen.generate({
        prompt,
        size: upstreamSize,
        seconds,
        refs: refPaths,
      });
      const ext = r.mime.includes('webm') ? '.webm' : r.mime.includes('quicktime') ? '.mov' : '.mp4';
      const objectKey = `${keyDir}/01${ext}`;
      fs.writeFileSync(path.join(this.storageRoot(), objectKey), r.buffer);
      await this.oss.putObjectSafe(r.buffer, objectKey, r.mime || 'video/mp4');
      Object.assign(item, { status: 'done', objectKey, via: r.via, ms: Date.now() - t0 });
      this.saveJob(legacy);
      await opts?.onProgress?.({ percent: 85, step: 'upload', message: '上传完成', done: 1, total: 1 });
    } catch (e: any) {
      item.status = 'failed';
      item.error = String(e.message || e).slice(0, 500);
      item.ms = Date.now() - t0;
      legacy.status = 'failed';
      this.saveJob(legacy);
      // 标记 set failed
      if (setId && this.dataSource && process.env.DB_ENABLED === 'true') {
        try {
          await this.setsRepo().update(
            { id: setId, tenantId: user.tenantId },
            { status: 'failed', images: [{ index: 0, status: 'failed', error: item.error }] as any },
          );
        } catch {
          /* ignore */
        }
      }
      throw e;
    }

    legacy.status = 'done';
    this.saveJob(legacy);

    const setResult = await this.persistVideoSetAfterGenerate(user, productId, product, {
      setId,
      frameworkJobId: String(input._frameworkJobId || ''),
      legacyJobId: legacy.id,
      templateId: tpl.id,
      input: {
        ...(input as GenerateInput),
        mediaKind: 'video',
        feature,
        count: 1,
        sizeId,
      },
      item,
      seconds,
      size: upstreamSize,
    });

    await opts?.onProgress?.({ percent: 100, step: 'done', message: '视频已完成', done: 1, total: 1 });

    return {
      promoJobId: legacy.id,
      setId: setResult.setId,
      templateId: tpl.id,
      kind: 'video',
      status: 'done',
      caption: setResult.caption,
      done: 1,
      total: 1,
      items: [
        {
          index: 0,
          status: 'done',
          url: item.objectKey ? this.publicUrl(item.objectKey) : null,
          mediaId: item.savedMediaId || null,
          mimeType: 'video/mp4',
          ms: item.ms,
        },
      ],
    };
  }

  /** 视频生成成功：promo_sets(kind=video) + media_assets(type=video)；不写入封面图列表 */
  private async persistVideoSetAfterGenerate(
    user: AuthContext,
    productId: string,
    product: any,
    opts: {
      setId: string;
      frameworkJobId: string;
      legacyJobId: string;
      templateId: string;
      input: GenerateInput;
      item: JobItem;
      seconds: number;
      size: string;
    },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { setId: opts.setId || opts.legacyJobId, caption: '' };
    }
    const repo = this.setsRepo();
    const mediaRepo = this.dataSource.getRepository(MediaAsset);
    let setId = opts.setId;
    let row = setId
      ? await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } })
      : null;
    if (!row) {
      setId = setId || newId('ps');
      row = repo.create({
        id: setId,
        tenantId: user.tenantId,
        productId,
        templateId: opts.templateId,
        params: null,
        caption: null,
        jobId: null,
        legacyJobId: opts.legacyJobId,
        status: 'generating',
        images: [],
      });
    }

    // 重生：软删本组旧视频 media
    if (row.images?.length) {
      const oldIds = row.images.map((i) => i.mediaId).filter(Boolean) as string[];
      for (const mid of oldIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
    }

    const caption = this.captionFor(product, opts.input, opts.templateId);
    let mediaId: string | undefined;
    if (opts.item.status === 'done' && opts.item.objectKey) {
      const abs = path.join(this.storageRoot(), opts.item.objectKey);
      const sizeBytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
      const mime = opts.item.objectKey.endsWith('.webm')
        ? 'video/webm'
        : opts.item.objectKey.endsWith('.mov')
          ? 'video/quicktime'
          : 'video/mp4';
      const saved = await mediaRepo.save(
        mediaRepo.create({
          tenantId: user.tenantId,
          productId,
          promoSetId: setId,
          type: 'video',
          provider: this.oss.mediaProvider(),
          objectKey: opts.item.objectKey,
          mimeType: mime,
          sizeBytes: String(sizeBytes),
          status: 'active',
        }),
      );
      mediaId = saved.id;
      opts.item.savedMediaId = mediaId;
    }

    const images: PromoSetImage[] = [
      {
        index: 0,
        status: opts.item.status === 'done' ? 'done' : 'failed',
        objectKey: opts.item.objectKey,
        mediaId,
        error: opts.item.error,
        ms: opts.item.ms,
      },
    ];

    row.templateId = opts.templateId;
    row.params = {
      kind: 'video',
      mediaKind: 'video',
      templateId: opts.templateId,
      feature: opts.input.feature || '',
      referenceAssetIds: opts.input.referenceAssetIds || [],
      count: 1,
      sizeId: opts.input.sizeId,
      seconds: opts.seconds,
      size: opts.size,
      styleNo: product.styleNo,
    };
    row.caption = caption;
    row.jobId = opts.frameworkJobId || row.jobId;
    row.legacyJobId = opts.legacyJobId;
    row.status = opts.item.status === 'done' ? 'done' : 'failed';
    row.images = images;
    await repo.save(row);

    try {
      const legacy = this.loadJob(user, productId, opts.legacyJobId);
      legacy.items = [opts.item];
      this.saveJob(legacy);
    } catch {
      /* ignore */
    }
    return { setId, caption };
  }

  /** 查找同商品+模板（或指定 set）进行中的生图，用于防双开 */
  private async findActivePromo(
    user: AuthContext,
    productId: string,
    templateId: string,
    setId?: string,
    jobType: 'promo_image' | 'promo_video' = 'promo_image',
  ) {
    const repo = this.setsRepo();
    if (setId) {
      const row = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (row && row.status === 'generating' && row.jobId) {
        try {
          const j = await this.jobs.get(user, row.jobId);
          if (j.status === 'queued' || j.status === 'running') {
            return {
              id: j.id,
              jobId: j.id,
              setId: row.id,
              status: j.status,
              templateId,
              caption: row.caption || '',
              createdAt: j.createdAt,
              updatedAt: j.updatedAt,
              progress: j.progress,
              done: (j.progress as any)?.done || 0,
              total: (j.progress as any)?.total || 0,
              items: [],
              reused: true,
            };
          }
        } catch {
          /* fall through */
        }
      }
    } else {
      const busySets = await repo.find({
        where: { tenantId: user.tenantId, productId, templateId, status: 'generating' },
        order: { createdAt: 'DESC' },
        take: 5,
      });
      for (const row of busySets) {
        if (!row.jobId) continue;
        try {
          const j = await this.jobs.get(user, row.jobId);
          if (j.status === 'queued' || j.status === 'running') {
            return {
              id: j.id,
              jobId: j.id,
              setId: row.id,
              status: j.status,
              templateId,
              caption: row.caption || '',
              createdAt: j.createdAt,
              updatedAt: j.updatedAt,
              progress: j.progress,
              done: (j.progress as any)?.done || 0,
              total: (j.progress as any)?.total || 0,
              items: [],
              reused: true,
            };
          }
        } catch {
          /* next */
        }
      }
      // 组尚未落库但 job 已排队
      try {
        const { items } = await this.jobs.list(user, { type: jobType, limit: 30 });
        const hit = items.find(
          (j) =>
            (j.status === 'queued' || j.status === 'running') &&
            (j.payload as any)?.productId === productId &&
            (j.payload as any)?.templateId === templateId,
        );
        if (hit) {
          return {
            id: hit.id,
            jobId: hit.id,
            setId: (hit.payload as any)?.setId || '',
            status: hit.status,
            templateId,
            caption: '',
            createdAt: hit.createdAt,
            updatedAt: hit.updatedAt,
            progress: hit.progress,
            done: (hit.progress as any)?.done || 0,
            total: (hit.progress as any)?.total || 0,
            items: [],
            reused: true,
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** 整组重生成：沿用 params，复用同组 job */
  async regenerateSet(user: AuthContext, productId: string, setId: string) {
    const set = await this.getSetEntity(user, productId, setId);
    const p = (set.params || {}) as unknown as GenerateInput;
    if (!p.templateId || !(p.referenceAssetIds || []).length) {
      throw new BadRequestException('该组缺少生成参数，无法重生成');
    }
    return this.generate(user, productId, { ...p, setId, regenIndexes: undefined });
  }

  /** 单张重生成（兼容旧路径） */
  async regenerateImage(user: AuthContext, productId: string, setId: string, index: number) {
    return this.regenerateImages(user, productId, setId, [index]);
  }

  /** 批量局部重生成：一次请求、一个 job、同一 set */
  async regenerateImages(user: AuthContext, productId: string, setId: string, indexes: number[]) {
    const set = await this.getSetEntity(user, productId, setId);
    const p = (set.params || {}) as unknown as GenerateInput;
    if (!p.templateId || !(p.referenceAssetIds || []).length) {
      throw new BadRequestException('该组缺少生成参数，无法重生成');
    }
    const idxs = [...new Set((indexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))];
    if (!idxs.length) throw new BadRequestException('请指定要重生成的图片下标');
    return this.generate(user, productId, { ...p, setId, regenIndexes: idxs });
  }

  private async getSetEntity(user: AuthContext, productId: string, setId: string) {
    await this.products.getDetail(user, productId);
    const set = await this.setsRepo().findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
    if (!set) throw new NotFoundException('宣传图组不存在');
    return set;
  }

  /**
   * 通用 Job worker 回调：执行生图并回写 progress/result。
   */
  async executeGenerateJob(
    user: AuthContext,
    productId: string,
    input: GenerateInput & Record<string, unknown>,
    opts?: { onProgress?: (p: Partial<JobProgress>) => Promise<void> },
  ) {
    const tpl = findTemplate(String(input?.templateId || ''));
    if (!tpl) throw new Error('未知模板');
    if (!this.gen.configured()) throw new Error('服务端未配置生图密钥');
    const { product, assets } = await this.productAssets(user, productId);
    const refIds = ((input.referenceAssetIds as string[]) || []).filter(Boolean);
    if (refIds.length < tpl.reference.min || refIds.length > tpl.reference.max) {
      throw new Error(`该模板需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    const byId = new Map(assets.map((a) => [a.id, a]));
    const refs = refIds.map((id) => byId.get(id));
    if (refs.some((r) => !r)) throw new Error('参考图不属于该商品');

    let model = null as (typeof MODELS)[number] | null;
    if (tpl.model !== 'none' && input.modelId) {
      model = MODELS.find((m) => m.id === input.modelId) || null;
      if (!model) throw new Error('未知模特');
    }
    if (tpl.model === 'required' && !model) throw new Error('该模板需要选择模特');

    const colorsAll = Array.isArray(input.colors)
      ? (input.colors as string[]).map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    const isMultiColor = tpl.id === 'multi_color';
    let count: number;
    if (isMultiColor) {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, colorsAll.length));
      if (colorsAll.length < tpl.count.min) throw new Error(`多色展示至少 ${tpl.count.min} 个颜色`);
      if (colorsAll.length !== refIds.length) {
        throw new Error(`多色展示需颜色与参考图 1:1（${colorsAll.length} 色 / ${refIds.length} 张图）`);
      }
      if (!model) throw new Error('多色展示需要选择模特');
      count = colorsAll.length;
    } else {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, Number(input.count) || tpl.count.default));
    }
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    let poses = tpl.poses.filter((o) => ((input.poses as string[]) || []).includes(o.id));
    let scenes = tpl.scenes.filter((o) => ((input.scenes as string[]) || []).includes(o.id));
    // multi_color：全组同一姿态/场景（只用第一个），不跨 index 轮换
    if (isMultiColor) {
      poses = poses.length ? [poses[0]] : tpl.poses[0] ? [tpl.poses[0]] : [];
      scenes = scenes.length ? [scenes[0]] : tpl.scenes[0] ? [tpl.scenes[0]] : [];
    }
    // 自由文本：匹配预设或生成 custom option（整组共用）
    const poseTextEarly = String(input.poseText || '').trim();
    const sceneTextEarly = String(input.sceneText || '').trim();
    if (poseTextEarly && tpl.poses.length) {
      const resolved = resolveOption(tpl.poses, (input.poses as string[]) || [], poseTextEarly, 'pose');
      if (resolved) poses = [resolved];
    }
    if (sceneTextEarly && tpl.scenes.length) {
      const resolved = resolveOption(tpl.scenes, (input.scenes as string[]) || [], sceneTextEarly, 'scene');
      if (resolved) scenes = [resolved];
    }
    const feature = String(
      input.feature ?? this.readFeature(user.tenantId, productId)?.feature ?? this.defaultFeature(product),
    ).slice(0, 2000);
    let poseText = String(input.poseText || '').trim();
    let sceneText = String(input.sceneText || '').trim();
    // 自由描述 → 关键词拆解 + 英文生图片段（LLM 优先，否则启发式）；自定义文案覆盖芯片 prompt
    if (poseText || sceneText) {
      try {
        const enriched = await enrichPoseSceneText(this.vision, { poseText, sceneText });
        if (enriched) {
          poseText = enriched.posePrompt || poseText;
          sceneText = enriched.scenePrompt || sceneText;
          this.logger.log(
            `pose-scene enrich via=${enriched.via} kw=${(enriched.keywords || []).slice(0, 8).join(',')}`,
          );
        }
      } catch (e: any) {
        this.logger.warn(`pose-scene enrich skip: ${e?.message || e}`);
      }
    }

    const regenRaw = (input.regenIndexes as number[]) || [];
    const regenSet = new Set(regenRaw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0));
    const onlyRegen = regenSet.size > 0;

    // 若是单张重生成且已有 set，保留其它张
    let priorImages: PromoSetImage[] = [];
    const setId = String(input.setId || '');
    if (setId && this.dataSource && process.env.DB_ENABLED === 'true') {
      const existing = await this.setsRepo().findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (existing?.images?.length) priorImages = existing.images;
    }

    const items: JobItem[] = [];
    for (let i = 0; i < count; i++) {
      const pose = isMultiColor
        ? (poses[0] || tpl.poses[0] || null)
        : poses.length
          ? poses[i % poses.length]
          : tpl.poses[0] || null;
      const scene = isMultiColor
        ? (scenes[0] || tpl.scenes[0] || null)
        : scenes.length
          ? scenes[Math.floor(i / Math.max(1, poses.length)) % scenes.length]
          : tpl.scenes[0] || null;
      const prior = priorImages.find((x) => x.index === i);
      if (onlyRegen && !regenSet.has(i) && prior?.objectKey && prior.status === 'done') {
        items.push({
          index: i,
          status: 'done',
          poseId: prior.poseId || pose?.id,
          sceneId: prior.sceneId || scene?.id,
          objectKey: prior.objectKey,
          savedMediaId: prior.mediaId,
          prompt: '',
        });
        continue;
      }
      const colorsForPrompt = isMultiColor
        ? [colorsAll[i]].filter(Boolean)
        : colorsAll;
      items.push({
        index: i,
        status: 'pending',
        poseId: pose?.id,
        sceneId: scene?.id,
        prompt: tpl.buildPrompt({
          feature,
          model,
          pose,
          scene,
          poseText: poseText || undefined,
          sceneText: sceneText || undefined,
          colors: colorsForPrompt,
          index: i,
          total: count,
        }),
      });
    }

    // 兼容旧版按商品落盘的 job 文件，便于原 UI 轮询
    const legacy: PromoJob = {
      id: newId('pj'),
      tenantId: user.tenantId,
      productId,
      templateId: tpl.id,
      status: 'running',
      input: {
        ...(input as GenerateInput),
        feature,
        count,
        sizeId,
        colors: isMultiColor ? colorsAll : (input.colors as string[]) || [],
        _frameworkJobId: String(input._frameworkJobId || ''),
      } as any,
      size: SIZES[sizeId].upstream,
      items,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveJob(legacy);

    // 商品参考图：ensureLocal（OSS→本地）；缺一不可
    const refPaths: string[] = [];
    for (const r of refs) {
      const local = await this.ensureLocal(r!.objectKey);
      if (!local) throw new Error(`参考图本地不可用：${r!.objectKey}`);
      refPaths.push(local);
    }

    // 风格样例：整组共用；ensureLocal 失败则降级去掉该张并记 warn
    const styleKeysRaw = this.normalizeStyleRefs(user, input.styleRefObjectKeys);
    const styleStrength = this.normalizeStyleStrength(input.styleStrength);
    const stylePaths: string[] = [];
    const styleWarns: string[] = [];
    for (const k of styleKeysRaw) {
      const local = await this.ensureLocal(k);
      if (!local) {
        styleWarns.push(`风格样例不可用已跳过：${k}`);
        continue;
      }
      stylePaths.push(local);
    }
    if (styleWarns.length) {
      this.logger.warn(`style-ref degrade productId=${productId}: ${styleWarns.join('; ')}`);
    }

    const keyDir = `tenants/${user.tenantId}/products/${product.styleNo}/promo/${legacy.id}`;
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });

    let done = 0;
    await Promise.all(
      items.map(async (it) => {
        if (it.status === 'done' && it.objectKey) {
          done += 1;
          const okKeep = items.filter((x) => x.status === 'done').length;
          await opts?.onProgress?.({
            percent: Math.min(95, Math.round((done / items.length) * 90) + 5),
            step: 'generating',
            message: `生图 ${done}/${items.length}`,
            done: okKeep,
            total: items.length,
          });
          return;
        }
        await this.acquire();
        const t0 = Date.now();
        try {
          it.status = 'running';
          this.saveJob(legacy);
          // refs = 商品图(多色仅当前色) + 风格样例；空风格 = 现网路径
          const garmentRefs =
            isMultiColor && refPaths[it.index]
              ? [refPaths[it.index]]
              : refPaths;
          const refsForShot = stylePaths.length
            ? [...garmentRefs, ...stylePaths]
            : garmentRefs;
          const styleBlock = buildStyleRefPrompt({
            garmentRefCount: garmentRefs.length,
            styleRefCount: stylePaths.length,
            strength: styleStrength,
          });
          const prompt = styleBlock ? `${it.prompt} ${styleBlock}` : it.prompt;
          if (styleBlock) it.prompt = prompt;
          const r = await this.gen.generate({ prompt, size: legacy.size, refs: refsForShot });
          const ext = r.mime.includes('jpeg') ? '.jpg' : r.mime.includes('webp') ? '.webp' : '.png';
          const objectKey = `${keyDir}/${String(it.index + 1).padStart(2, '0')}${ext}`;
          fs.writeFileSync(path.join(this.storageRoot(), objectKey), r.buffer);
          await this.oss.putObjectSafe(r.buffer, objectKey, r.mime);
          Object.assign(it, { status: 'done', objectKey, via: r.via });
        } catch (e: any) {
          it.status = 'failed';
          it.error = String(e.message || e).slice(0, 500);
        } finally {
          it.ms = Date.now() - t0;
          done += 1;
          this.release();
          this.saveJob(legacy);
          const ok = items.filter((x) => x.status === 'done').length;
          await opts?.onProgress?.({
            percent: Math.min(95, Math.round((done / items.length) * 90) + 5),
            step: 'generating',
            message: `生图 ${done}/${items.length}`,
            done: ok,
            total: items.length,
          });
        }
      }),
    );

    const ok = items.filter((i) => i.status === 'done').length;
    legacy.status = ok === items.length ? 'done' : ok ? 'partial' : 'failed';
    this.saveJob(legacy);
    if (!ok) throw new Error(items.find((i) => i.error)?.error || '生图全部失败');

    const setResult = await this.persistSetAfterGenerate(user, productId, product, {
      setId: String(input.setId || ''),
      frameworkJobId: String(input._frameworkJobId || ''),
      legacyJobId: legacy.id,
      templateId: tpl.id,
      input: {
        ...(input as GenerateInput),
        feature,
        count,
        sizeId,
        styleRefObjectKeys: styleKeysRaw,
        styleStrength: styleKeysRaw.length ? styleStrength : undefined,
      },
      items,
      status: legacy.status === 'done' ? 'done' : 'partial',
    });

    return {
      promoJobId: legacy.id,
      setId: setResult.setId,
      templateId: tpl.id,
      status: legacy.status,
      caption: setResult.caption,
      done: ok,
      total: items.length,
      items: items.map((i) => ({
        index: i.index,
        status: i.status,
        url: i.objectKey ? this.publicUrl(i.objectKey) : null,
        mediaId: i.savedMediaId || null,
        error: i.error,
        ms: i.ms,
      })),
    };
  }

  /** 生成成功：upsert 宣传图组 + media_assets；宣传图绝不写入商品 coverMediaIds */
  private async persistSetAfterGenerate(
    user: AuthContext,
    productId: string,
    product: any,
    opts: {
      setId: string;
      frameworkJobId: string;
      legacyJobId: string;
      templateId: string;
      input: GenerateInput;
      items: JobItem[];
      status: 'done' | 'partial';
    },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { setId: opts.setId || opts.legacyJobId, caption: '' };
    }
    const repo = this.setsRepo();
    const mediaRepo = this.dataSource.getRepository(MediaAsset);
    let setId = opts.setId;
    let row = setId
      ? await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } })
      : null;
    if (!row) {
      setId = setId || newId('ps');
      row = repo.create({
        id: setId,
        tenantId: user.tenantId,
        productId,
        templateId: opts.templateId,
        params: null,
        caption: null,
        jobId: null,
        legacyJobId: opts.legacyJobId,
        status: 'generating',
        images: [],
      });
    }

    const caption = this.captionFor(product, opts.input, opts.templateId);
    const addedMediaIds: string[] = [];
    const images: PromoSetImage[] = [];

    // 整组重生成：清掉本组旧 media（单张重生成保留未改动的）
    const regenOnly = Array.isArray((opts.input as any).regenIndexes) && (opts.input as any).regenIndexes.length > 0;
    if (!regenOnly && row.images?.length) {
      const oldIds = row.images.map((i) => i.mediaId).filter(Boolean) as string[];
      for (const mid of oldIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
      if (oldIds.length) {
        const covers = (product.coverMediaIds || []).filter((id: string) => !oldIds.includes(id));
        product.coverMediaIds = covers;
        await this.products.update(user, productId, { coverMediaIds: covers });
      }
    }

    for (const it of opts.items) {
      if (it.status !== 'done' || !it.objectKey) {
        images.push({
          index: it.index,
          status: it.status === 'failed' ? 'failed' : it.status,
          poseId: it.poseId,
          sceneId: it.sceneId,
          error: it.error,
          ms: it.ms,
          objectKey: it.objectKey,
          mediaId: it.savedMediaId,
        });
        continue;
      }
      let mediaId = it.savedMediaId;
      if (!mediaId) {
        const abs = path.join(this.storageRoot(), it.objectKey);
        const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
        const saved = await mediaRepo.save(
          mediaRepo.create({
            tenantId: user.tenantId,
            productId,
            promoSetId: setId,
            type: 'image',
            provider: this.oss.mediaProvider(),
            objectKey: it.objectKey,
            mimeType: it.objectKey.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
            sizeBytes: String(size),
            status: 'active',
          }),
        );
        mediaId = saved.id;
        it.savedMediaId = mediaId;
        addedMediaIds.push(mediaId);
      } else {
        await mediaRepo.update({ id: mediaId, tenantId: user.tenantId }, { promoSetId: setId, productId });
      }
      images.push({
        index: it.index,
        status: 'done',
        objectKey: it.objectKey,
        mediaId,
        poseId: it.poseId,
        sceneId: it.sceneId,
        ms: it.ms,
      });
    }

    row.templateId = opts.templateId;
    const styleKeys = Array.isArray(opts.input.styleRefObjectKeys)
      ? opts.input.styleRefObjectKeys.filter(Boolean)
      : [];
    row.params = {
      templateId: opts.templateId,
      feature: opts.input.feature || '',
      referenceAssetIds: opts.input.referenceAssetIds || [],
      modelId: opts.input.modelId || null,
      poses: opts.input.poses || [],
      scenes: opts.input.scenes || [],
      poseText: opts.input.poseText || undefined,
      sceneText: opts.input.sceneText || undefined,
      colors: opts.input.colors || [],
      count: opts.input.count,
      sizeId: opts.input.sizeId,
      styleRefObjectKeys: styleKeys,
      styleStrength: styleKeys.length
        ? this.normalizeStyleStrength(opts.input.styleStrength)
        : undefined,
    };
    row.caption = caption;
    row.jobId = opts.frameworkJobId || row.jobId;
    row.legacyJobId = opts.legacyJobId;
    row.status = opts.status;
    row.images = images;
    await repo.save(row);
    try {
      const legacy = this.loadJob(user, productId, opts.legacyJobId);
      legacy.items = opts.items;
      this.saveJob(legacy);
    } catch {
      /* ignore */
    }

    // 站规：宣传图只进 promo_sets / media_assets(promoSetId)，不进商品图 coverMediaIds
    if (addedMediaIds.length) {
      const covers = (product.coverMediaIds || []).filter((id: string) => !addedMediaIds.includes(id));
      // 顺带清掉历史误写入的本组宣传图
      const setMediaIds = images.map((i) => i.mediaId).filter(Boolean) as string[];
      const cleaned = covers.filter((id: string) => !setMediaIds.includes(id));
      if (cleaned.length !== (product.coverMediaIds || []).length) {
        await this.products.update(user, productId, { coverMediaIds: cleaned });
      }
    }
    return { setId, caption };
  }


  private async acquire() {
    if (this.running < MAX_CONCURRENCY) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
  }
  private release() {
    this.running--;
    const w = this.waiters.shift();
    if (w) w();
  }

  private async runJob(job: PromoJob, refPaths: string[], keyDir: string) {
    job.status = 'running';
    this.saveJob(job);
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });
    await Promise.all(
      job.items.map(async (it) => {
        await this.acquire();
        const t0 = Date.now();
        try {
          it.status = 'running';
          this.saveJob(job);
          const r = await this.gen.generate({ prompt: it.prompt, size: job.size, refs: refPaths });
          const ext = r.mime.includes('jpeg') ? '.jpg' : r.mime.includes('webp') ? '.webp' : '.png';
          const objectKey = `${keyDir}/${String(it.index + 1).padStart(2, '0')}${ext}`;
          fs.writeFileSync(path.join(this.storageRoot(), objectKey), r.buffer);
          await this.oss.putObjectSafe(r.buffer, objectKey, r.mime);
          Object.assign(it, { status: 'done', objectKey, via: r.via });
        } catch (e: any) {
          it.status = 'failed';
          it.error = String(e.message || e).slice(0, 500);
        } finally {
          it.ms = Date.now() - t0;
          this.release();
          this.saveJob(job);
        }
      }),
    );
    const ok = job.items.filter((i) => i.status === 'done').length;
    job.status = ok === job.items.length ? 'done' : ok ? 'partial' : 'failed';
    this.saveJob(job);
    this.logger.log(`job ${job.id} ${job.status} ${ok}/${job.items.length}`);
  }

  private jobFile(tenantId: string, productId: string, jobId: string) {
    if (!/^pj_[a-f0-9]+$/.test(jobId)) throw new NotFoundException('任务不存在');
    return path.join(this.stateDir(tenantId, productId), `${jobId}.json`);
  }
  private saveJob(job: PromoJob) {
    job.updatedAt = Date.now();
    fs.writeFileSync(this.jobFile(job.tenantId, job.productId, job.id), JSON.stringify(job, null, 1));
  }
  private loadJob(user: AuthContext, productId: string, jobId: string): PromoJob {
    const f = this.jobFile(user.tenantId, productId, jobId);
    if (!fs.existsSync(f)) throw new NotFoundException('任务不存在');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  private jobDto(job: PromoJob) {
    const displayTitle = buildJobDisplayTitle('promo_image', {
      ...(job.input as any),
      templateId: job.templateId,
      displayTitle: job.templateId === 'multi_color' ? undefined : (job.input as any)?.displayTitle,
    });
    return {
      id: job.id,
      templateId: job.templateId,
      templateName: displayTitle || findTemplate(job.templateId)?.name || '宣传生图',
      displayTitle,
      title: displayTitle,
      status: job.status,
      size: job.size,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      done: job.items.filter((i) => i.status === 'done').length,
      total: job.items.length,
      items: job.items.map((i) => ({
        index: i.index,
        status: i.status,
        poseId: i.poseId,
        sceneId: i.sceneId,
        url: i.objectKey ? this.publicUrl(i.objectKey) : null,
        error: i.error,
        saved: !!i.savedMediaId,
        ms: i.ms,
      })),
    };
  }

  async getJob(user: AuthContext, productId: string, jobId: string) {
    await this.products.getDetail(user, productId);
    // 框架 jobId（job_*）→ 若已写出 legacy pj_* 则返回图集；否则返回进度占位
    if (!/^pj_/.test(jobId)) {
      const fj = await this.jobs.get(user, jobId);
      const promoJobId = (fj.result as any)?.promoJobId as string | undefined;
      if (promoJobId && fs.existsSync(this.jobFile(user.tenantId, productId, promoJobId))) {
        const dto = this.jobDto(this.loadJob(user, productId, promoJobId));
        return {
          ...dto,
          frameworkJobId: fj.id,
          setId: (fj.result as any)?.setId || (fj.payload as any)?.setId,
          caption: (fj.result as any)?.caption,
          progress: fj.progress,
          error: fj.error,
        };
      }
      const statusMap: Record<string, string> = {
        queued: 'queued',
        running: 'running',
        succeeded: 'done',
        failed: 'failed',
        cancelled: 'failed',
      };
      return {
        id: fj.id,
        frameworkJobId: fj.id,
        setId: (fj.payload as any)?.setId,
        templateId: (fj.payload as any)?.templateId,
        status: statusMap[fj.status] || fj.status,
        createdAt: fj.createdAt,
        updatedAt: fj.updatedAt,
        progress: fj.progress,
        done: (fj.progress as any)?.done || 0,
        total: (fj.progress as any)?.total || 0,
        items: [],
        error: fj.error,
      };
    }
    return this.jobDto(this.loadJob(user, productId, jobId));
  }

  async listJobs(user: AuthContext, productId: string) {
    await this.products.getDetail(user, productId);
    const dir = this.stateDir(user.tenantId, productId);
    const legacyRaw: PromoJob[] = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.startsWith('pj_') && f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PromoJob)
      : [];

    // 附带仍在排队/执行中的框架任务（尚未写出 pj_* 时也能在宣传图页看到）
    let pendingJobs: any[] = [];
    try {
      const imageJobs = await this.jobs.list(user, { type: 'promo_image', limit: 50 });
      const videoJobs = await this.jobs.list(user, { type: 'promo_video', limit: 30 });
      pendingJobs = [...(imageJobs.items || []), ...(videoJobs.items || [])]
        .filter((j) => (j.payload as any)?.productId === productId)
        .filter((j) => j.status === 'queued' || j.status === 'running');
    } catch {
      /* ignore */
    }

    const activeFwIds = new Set(pendingJobs.map((j) => j.id));
    // legacy 若挂了进行中的框架 job，不再单独列出（避免双行：job_* + pj_*）
    const legacy = legacyRaw
      .filter((j) => {
        const fw = String((j.input as any)?._frameworkJobId || '');
        if (fw && activeFwIds.has(fw)) return false;
        return true;
      })
      .map((j) => this.jobDto(j));

    // 已写出 promoJobId / 或同 set 已有 legacy 进度时，不再塞框架占位行
    const legacyFwLinked = new Set(
      legacyRaw
        .map((j) => String((j.input as any)?._frameworkJobId || ''))
        .filter(Boolean),
    );
    const pending = pendingJobs
      .filter((j) => !((j.result as any)?.promoJobId))
      .filter((j) => !legacyFwLinked.has(j.id))
      .map((j) => ({
        id: j.id,
        frameworkJobId: j.id,
        setId: (j.payload as any)?.setId,
        templateId: (j.payload as any)?.templateId,
        status: j.status === 'queued' ? 'queued' : 'running',
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        progress: j.progress,
        done: (j.progress as any)?.done || 0,
        total: (j.progress as any)?.total || 0,
        items: [],
        error: j.error,
        title: buildJobDisplayTitle(j.type || 'promo_image', j.payload as any),
        displayTitle: buildJobDisplayTitle(j.type || 'promo_image', j.payload as any),
        kind: j.type === 'promo_video' ? 'video' : 'image',
      }));

    return [...pending, ...legacy]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 30);
  }

  // ---------- 宣传图组（UI 以 set 为中心） ----------
  private setDto(row: PromoSetEntity) {
    const images = (row.images || []).map((i) => {
      const regenerating = i.status === 'pending' || i.status === 'running';
      return {
        index: i.index,
        status: i.status,
        poseId: i.poseId,
        sceneId: i.sceneId,
        mediaId: i.mediaId || null,
        // 重生中的槽位先藏旧图，列表立刻出现「生成中」占位
        url: i.objectKey && !regenerating ? this.publicUrl(i.objectKey) : null,
        error: i.error,
        ms: i.ms,
        saved: !!i.mediaId,
        regenerating: !!regenerating && !!i.objectKey,
      };
    });
    const done = images.filter((i) => i.status === 'done' && i.url).length;
    const tpl = findTemplate(row.templateId);
    const kind = (row as any).kind || (row.params as any)?.kind || (row.params as any)?.mediaKind || 'image';
    const jobType = kind === 'video' || kind === 'promo_video' ? 'promo_video' : 'promo_image';
    const displayTitle = buildJobDisplayTitle(jobType, {
      ...(row.params as any),
      templateId: row.templateId,
      displayTitle: row.templateId === 'multi_color' ? undefined : (row.params as any)?.displayTitle,
      styleNo: (row.params as any)?.styleNo,
    });
    const posterUrl =
      (row.params as any)?.posterUrl ||
      (images.find((i) => i.url)?.url) ||
      null;
    return {
      id: row.id,
      setId: row.id,
      productId: row.productId,
      kind,
      type: kind,
      posterUrl: kind === 'video' || kind === 'promo_video' ? posterUrl : null,
      coverUrl: kind === 'video' || kind === 'promo_video' ? posterUrl : null,
      templateId: row.templateId,
      templateName: displayTitle || tpl?.name || row.templateId,
      displayTitle,
      params: row.params,
      caption: row.caption || '',
      jobId: row.jobId,
      legacyJobId: row.legacyJobId,
      status: row.status,
      done,
      total: images.length || Number((row.params as any)?.count) || 0,
      items: images,
      createdAt: row.createdAt?.getTime?.() ?? row.createdAt,
      updatedAt: row.updatedAt?.getTime?.() ?? row.updatedAt,
    };
  }

  async listSets(user: AuthContext, productId: string) {
    await this.products.getDetail(user, productId);
    await this.migrateLegacyJobsToSets(user, productId);
    const rows = await this.setsRepo().find({
      where: { tenantId: user.tenantId, productId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    // 附带尚未落库完成的排队中任务（仅 payload.setId 已有）
    const dtos = rows.map((r) => this.setDto(r));
    try {
      const imageJobs = await this.jobs.list(user, { type: 'promo_image', limit: 30 });
      const videoJobs = await this.jobs.list(user, { type: 'promo_video', limit: 30 });
      const items = [...(imageJobs.items || []), ...(videoJobs.items || [])];
      for (const j of items) {
        if ((j.payload as any)?.productId !== productId) continue;
        const sid = (j.payload as any)?.setId as string | undefined;
        const hit = sid && dtos.find((d) => d.id === sid);
        if (!hit) continue;
        if (j.status === 'queued' || j.status === 'running') {
          hit.status = 'generating';
          hit.jobId = j.id;
          (hit as any).progress = j.progress;
          (hit as any).busy = true;
          if (j.type === 'promo_video') {
            hit.kind = 'video';
            hit.type = 'video';
          }
          continue;
        }
        if (
          hit.status === 'generating' &&
          hit.jobId === j.id &&
          (j.status === 'failed' || j.status === 'cancelled')
        ) {
          hit.status = 'failed';
          (hit as any).busy = false;
          try {
            await this.setsRepo().update(
              { id: hit.id, tenantId: user.tenantId },
              { status: 'failed' },
            );
          } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }
    const mapped = dtos
      .filter((d) => {
        const busy = d.status === 'generating' || (d as any).busy;
        const empty = !(d.total > 0) && !(d.items && d.items.length);
        // 空壳 generating 且没有挂上活 job → 幽灵组，不展示
        if (empty && d.status === 'generating' && !d.jobId && !(d as any).busy) return false;
        if (empty && !busy && d.status !== 'done' && d.status !== 'partial') return false;
        return true;
      })
      .map((d) => ({
        ...d,
        busy: d.status === 'generating' || (d as any).busy,
      }));
    return this.collapseBusySetsByTemplate(mapped);
  }

  /** 同模板多条 generating 只留最新，避免素材列表「两条多色」 */
  private collapseBusySetsByTemplate<T extends { id: string; templateId?: string; busy?: boolean; status?: string; createdAt?: any }>(
    sets: T[],
  ): T[] {
    const seenBusyTpl = new Set<string>();
    const out: T[] = [];
    for (const s of sets) {
      const busy = !!(s.busy || s.status === 'generating' || s.status === 'queued');
      const tpl = String(s.templateId || '');
      if (busy && tpl) {
        if (seenBusyTpl.has(tpl)) continue;
        seenBusyTpl.add(tpl);
      }
      out.push(s);
    }
    return out;
  }

  async getSet(user: AuthContext, productId: string, setId: string) {
    const row = await this.getSetEntity(user, productId, setId);
    const dto = this.setDto(row);
    if (row.jobId) {
      try {
        const fj = await this.jobs.get(user, row.jobId);
        (dto as any).progress = fj.progress;
        (dto as any).frameworkStatus = fj.status;
        if (fj.status === 'queued' || fj.status === 'running') {
          dto.status = 'generating';
          (dto as any).busy = true;
        } else if (
          row.status === 'generating' &&
          (fj.status === 'failed' || fj.status === 'cancelled')
        ) {
          dto.status = 'failed';
          (dto as any).busy = false;
          row.status = 'failed';
          await this.setsRepo().save(row);
        }
      } catch {
        /* ignore */
      }
    }
    return dto;
  }

  async deleteSet(user: AuthContext, productId: string, setId: string) {
    const row = await this.getSetEntity(user, productId, setId);
    const product: any = await this.products.getDetail(user, productId);
    const mediaIds = (row.images || []).map((i) => i.mediaId).filter(Boolean) as string[];
    if (this.dataSource && mediaIds.length) {
      const mediaRepo = this.dataSource.getRepository(MediaAsset);
      for (const mid of mediaIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
      const covers = (product.coverMediaIds || []).filter((id: string) => !mediaIds.includes(id));
      await this.products.update(user, productId, { coverMediaIds: covers });
    }
    await this.setsRepo().delete({ id: setId, tenantId: user.tenantId, productId });
    return { deleted: setId, mediaRemoved: mediaIds.length };
  }

  /** 把旧 pj_* 文件一次性迁入 promo_sets（幂等） */
  private async migrateLegacyJobsToSets(user: AuthContext, productId: string) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return;
    const dir = this.stateDir(user.tenantId, productId);
    if (!fs.existsSync(dir)) return;
    const repo = this.setsRepo();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('pj_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const job: PromoJob = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!job?.id) continue;
        const existed = await repo.findOne({ where: { tenantId: user.tenantId, productId, legacyJobId: job.id } });
        if (existed) continue;
        const status =
          job.status === 'done' ? 'done' : job.status === 'partial' ? 'partial' : job.status === 'failed' ? 'failed' : 'generating';
        if (status === 'generating') continue;
        const images: PromoSetImage[] = (job.items || []).map((it) => ({
          index: it.index,
          status: it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : 'pending',
          objectKey: it.objectKey,
          mediaId: it.savedMediaId,
          poseId: it.poseId,
          sceneId: it.sceneId,
          error: it.error,
          ms: it.ms,
        }));
        const product: any = await this.products.getDetail(user, productId);
        const input = job.input || ({} as GenerateInput);
        await repo.save(
          repo.create({
            id: newId('ps'),
            tenantId: user.tenantId,
            productId,
            templateId: job.templateId,
            params: {
              templateId: job.templateId,
              feature: input.feature || '',
              referenceAssetIds: input.referenceAssetIds || [],
              modelId: input.modelId || null,
              poses: input.poses || [],
              scenes: input.scenes || [],
              colors: input.colors || [],
              count: input.count || job.items?.length,
              sizeId: input.sizeId,
              styleRefObjectKeys: input.styleRefObjectKeys || [],
              styleStrength: input.styleStrength,
            },
            caption: this.captionFor(product, input, job.templateId),
            jobId: null,
            legacyJobId: job.id,
            status: status as any,
            images,
          }),
        );
      } catch (e: any) {
        this.logger.warn(`migrate legacy ${f}: ${e.message || e}`);
      }
    }
  }

  /**
   * 兼容旧接口：仅确保宣传结果落 media_assets（带 promo 路径），
   * 绝不写入商品 coverMediaIds（商品图与宣传图分离）。
   */
  async saveToProduct(user: AuthContext, productId: string, jobId: string, body: { indexes?: number[] }) {
    const job = this.loadJob(user, productId, jobId);
    await this.products.getDetail(user, productId);
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) throw new BadRequestException('需开启数据库');
    const repo = this.dataSource.getRepository(MediaAsset);
    const want = body?.indexes?.length ? body.indexes : job.items.map((i) => i.index);
    const added: string[] = [];
    for (const it of job.items) {
      if (!want.includes(it.index) || it.status !== 'done' || !it.objectKey || it.savedMediaId) continue;
      const stInfo = fs.statSync(path.join(this.storageRoot(), it.objectKey));
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId,
          type: 'image',
          provider: this.oss.mediaProvider(),
          objectKey: it.objectKey,
          mimeType: it.objectKey.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
          sizeBytes: String(stInfo.size),
          status: 'active',
        }),
      );
      it.savedMediaId = saved.id;
      added.push(saved.id);
    }
    this.saveJob(job);
    return { added, job: this.jobDto(job), mixedIntoProductImages: false };
  }
}
