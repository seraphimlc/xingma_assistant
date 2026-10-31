import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { MediaAsset } from '../common/entities/media-asset.entity';
import { Product } from '../common/entities/product.entity';
import { ProductViewEvent } from '../common/entities/product-view-event.entity';
import { ShareEventBinding } from '../common/entities/share-event-binding.entity';
import { ShareEvent } from '../common/entities/share-event.entity';
import { LevelsService } from '../levels/levels.service';
import { JobsService } from '../jobs/jobs.service';
import { ProductAccessService, SharePolicy } from './product-access.service';
import {
  CreateProductInput,
  CreateSkuInput,
  ProductListQuery,
  ProductRec,
  UpdateProductInput,
} from './product.types';
import { IProductsRepository, PRODUCTS_REPO } from './repositories/products.repository';
import { OssClient } from '../media/oss.client';
import { parseNoteText } from './publish/parse-note';
import { ProductGroupsService } from './product-groups.service';
import { TenantsService } from '../tenants/tenants.service';
import { AuditService } from '../common/audit.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @Inject(PRODUCTS_REPO) private readonly repo: IProductsRepository,
    private readonly access: ProductAccessService,
    private readonly levels: LevelsService,
    private readonly jobs: JobsService,
    private readonly oss: OssClient,
    private readonly groups: ProductGroupsService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  /** 客户存图权限：租户全局开关（不再按商品） */
  private async resolveAllowCustomerDownload(tenantId: string): Promise<boolean> {
    try {
      const t = await this.tenants.getById(tenantId);
      return !!(t && t.allowCustomerDownload);
    } catch {
      return false;
    }
  }

  private publicUrl(objectKey: string) {
    return this.oss.publicUrl(objectKey);
  }

  /** 列表用：只解析首张封面，避免拉全量图片 */
  private isPromoAsset(row: { objectKey?: string; promoSetId?: string | null }) {
    if (row.promoSetId) return true;
    return String(row.objectKey || '').includes('/promo/');
  }

  /** 从 cover 列表剔除宣传图 mediaId（objectKey 含 /promo/ 或带 promoSetId） */
  private async filterProductCoverIds(tenantId: string, ids: string[]): Promise<string[]> {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return (ids || []).filter(Boolean);
    }
    const uniq = [...new Set((ids || []).filter(Boolean))];
    if (!uniq.length) return [];
    const rows = await this.dataSource.getRepository(MediaAsset).find({
      where: { tenantId, id: In(uniq), status: 'active' },
    });
    const ok = new Set(rows.filter((r) => !this.isPromoAsset(r)).map((r) => r.id));
    return uniq.filter((id) => ok.has(id));
  }

  /**
   * 编辑保存用：新加入的仍拒宣传图；已在 coverMediaIds 上的（含「追加到商品」）原序保留。
   */
  private async sanitizeCoverMediaIds(
    tenantId: string,
    productId: string,
    ids: string[],
    currentCovers: string[],
  ): Promise<string[]> {
    const requested = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!requested.length) return [];
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return [...new Set(requested)];
    }
    const uniqKeepOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);
      uniqKeepOrder.push(id);
    }
    const rows = await this.dataSource.getRepository(MediaAsset).find({
      where: { tenantId, id: In(uniqKeepOrder), status: 'active' },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const current = new Set((currentCovers || []).filter(Boolean));
    const out: string[] = [];
    for (const id of uniqKeepOrder) {
      const row = byId.get(id);
      if (!row) continue;
      if (row.productId && row.productId !== productId && !current.has(id)) continue;
      if (this.isPromoAsset(row) && !current.has(id)) continue;
      out.push(id);
    }
    return out;
  }

  /**
   * 生图/生视频成功后：把成片 mediaId 追加到商品 coverMediaIds 末尾（不替换；同 id 跳过）。
   * 允许宣传图/视频（业主显式追加）；须本租户且挂在该商品上。
   */
  async appendCoverMedia(user: AuthContext, productId: string, mediaIds: string[]) {
    this.assertStaff(user);
    const want = [...new Set((mediaIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!want.length) throw new BadRequestException('请提供 mediaIds');
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('需开启数据库');
    }
    const mediaRepo = this.dataSource.getRepository(MediaAsset);
    const rows = await mediaRepo.find({
      where: { tenantId: user.tenantId, id: In(want), status: 'active' },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = want.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new BadRequestException(`媒体不存在或不属于本租户：${missing.slice(0, 3).join(',')}`);
    }
    for (const id of want) {
      const row = byId.get(id)!;
      if (row.productId && row.productId !== productId) {
        throw new BadRequestException(`媒体不属于该商品：${id}`);
      }
      if (!row.productId) {
        throw new BadRequestException(`媒体未关联商品：${id}`);
      }
    }
    const existing = [...(p.coverMediaIds || [])];
    const have = new Set(existing);
    const appended: string[] = [];
    for (const id of want) {
      if (have.has(id)) continue;
      existing.push(id);
      have.add(id);
      appended.push(id);
    }
    const skipped = want.filter((id) => !appended.includes(id));
    const updated =
      appended.length > 0
        ? await this.repo.update(user.tenantId, productId, { coverMediaIds: existing })
        : p;
    if (!updated) throw new NotFoundException('商品不存在');
    const skus = await this.repo.listSkus(user.tenantId, productId);
    const dto = await this.withImages(user.tenantId, updated, this.toStaffDto(updated, skus));
    if (appended.length) {
      this.audit.enqueue({
        tenantId: user.tenantId,
        actor: user,
        action: 'product.cover.append',
        targetType: 'product',
        targetId: productId,
        detail: { appended, skipped, appendedCount: appended.length },
      });
    }
    return {
      ...dto,
      coverMediaIds: updated.coverMediaIds || existing,
      appended,
      skipped,
      appendedCount: appended.length,
      skippedCount: skipped.length,
    };
  }

  private async firstCoverUrl(tenantId: string, p: ProductRec): Promise<string> {
    const map = await this.batchFirstCoverUrls(tenantId, [p]);
    return map.get(p.id) || '';
  }

  /** Batch cover URLs for list endpoints — one media query instead of N findOne loops */
  private async batchFirstCoverUrls(tenantId: string, products: ProductRec[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!(this.dataSource && process.env.DB_ENABLED === 'true') || !products.length) return out;
    const repo = this.dataSource.getRepository(MediaAsset);
    const coverIds = [...new Set(products.flatMap((p) => p.coverMediaIds || []).filter(Boolean))];
    const productIds = products.map((p) => p.id);
    const [byCover, byProduct] = await Promise.all([
      coverIds.length
        ? repo.find({ where: { tenantId, id: In(coverIds), status: 'active' } })
        : Promise.resolve([] as MediaAsset[]),
      repo.find({
        where: { tenantId, productId: In(productIds), status: 'active', type: 'image' },
        order: { createdAt: 'ASC' },
        take: Math.min(products.length * 20, 400),
      }),
    ]);
    const coverMap = new Map(byCover.map((r) => [r.id, r]));
    const productMedia = new Map<string, MediaAsset[]>();
    for (const r of byProduct) {
      if (!r.productId) continue;
      const list = productMedia.get(r.productId) || [];
      list.push(r);
      productMedia.set(r.productId, list);
    }
    for (const p of products) {
      let url = '';
      for (const cid of p.coverMediaIds || []) {
        const row = coverMap.get(cid);
        // coverMediaIds 为准：含业主追加的宣传图；列表封面跳过纯视频
        if (row && String(row.type || 'image') !== 'video') {
          url = this.publicUrl(row.objectKey);
          break;
        }
      }
      if (!url) {
        const hit = (productMedia.get(p.id) || []).find((r) => !this.isPromoAsset(r));
        if (hit) url = this.publicUrl(hit.objectKey);
      }
      if (url) out.set(p.id, url);
    }
    return out;
  }

  private storageRoot() {
    return path.join(process.cwd(), 'storage');
  }

  /** 解析商品图序：以 coverMediaIds 为准（含业主「追加到商品」的宣传图/视频） */
  async resolveImages(tenantId: string, p: ProductRec) {
    const coverIds = p.coverMediaIds || [];
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return coverIds.map((id) => ({ id, url: '', isPromo: false, type: 'image' as const }));
    }
    const repo = this.dataSource.getRepository(MediaAsset);
    const coverRows = coverIds.length
      ? await repo.find({ where: { tenantId, id: In(coverIds), status: 'active' } })
      : [];
    const productRows = await repo.find({
      where: { tenantId, productId: p.id, status: 'active', type: 'image' },
    });
    const byId = new Map<string, MediaAsset>();
    for (const r of [...coverRows, ...productRows]) byId.set(r.id, r);
    const ordered: MediaAsset[] = [];
    const seen = new Set<string>();
    for (const id of coverIds) {
      const r = byId.get(id);
      if (r && !seen.has(r.id)) {
        ordered.push(r);
        seen.add(r.id);
      }
    }
    // 未进 cover 的商品图（非宣传）兼容补齐
    for (const r of productRows) {
      if (seen.has(r.id)) continue;
      if (this.isPromoAsset(r)) continue;
      ordered.push(r);
      seen.add(r.id);
    }
    return ordered.map((r) => ({
      id: r.id,
      url: this.publicUrl(r.objectKey),
      isPromo: this.isPromoAsset(r),
      type: (r.type || 'image') as string,
    }));
  }

  private async withImages<T extends Record<string, unknown>>(tenantId: string, p: ProductRec, dto: T) {
    const images = await this.resolveImages(tenantId, p);
    return {
      ...dto,
      images,
      coverUrl: images[0]?.url || null,
    };
  }

  /** 手工发品：解析笔记文本（不写库） */
  parseNote(text: string) {
    const suggestion = parseNoteText(text || '');
    return { suggestion };
  }

  /** 员工列表（可筛选） */
  async listForStaff(tenantId: string, query?: ProductListQuery) {
    const { items, total } = await this.repo.list(tenantId, query);
    if (!items.length) return { items: [], total };
    const [coverMap, skuMap] = await Promise.all([
      this.batchFirstCoverUrls(tenantId, items),
      this.repo.listSkusByProductIds(
        tenantId,
        items.map((p) => p.id),
      ),
    ]);
    // 列表页只要价文案/色数；不回传完整 skus，减轻 payload
    const withMeta = items.map((p) => {
      const dto = this.toStaffDto(p, skuMap.get(p.id) || []);
      const { skus: _skus, ...rest } = dto as typeof dto & { skus?: unknown };
      return { ...rest, coverUrl: coverMap.get(p.id) || '' };
    });
    return { items: withMeta, total };
  }

  /**
   * 客户目录：仅返回可看商品摘要；图片需另调签名接口。
   * 列表层也做服务端鉴权，不靠前端过滤。
   */
  async listForCustomer(
    user: AuthContext,
    opts?: { shareEventId?: string; boundCustomerId?: string; boundCustomerIds?: string[]; publicOnly?: boolean } & ProductListQuery,
  ) {
    const { items } = await this.repo.list(user.tenantId, {
      ...opts,
      status: opts?.status || 'on_sale',
    });
    const boundIds = await this.resolveShareBoundIds(
      user.tenantId,
      opts?.shareEventId,
      opts?.boundCustomerIds,
      opts?.boundCustomerId,
    );
    const levelCache = new Map<string, { policy: SharePolicy; minRank: number }>();
    const resolveLevel = async (p: ProductRec) => {
      const key = `${p.levelId || ''}|${p.sharePolicy || ''}`;
      if (levelCache.has(key)) return levelCache.get(key)!;
      let policy: SharePolicy = (p.sharePolicy as SharePolicy) || 'designated_only';
      let minRank = 0;
      try {
        const level = await this.levels.getProductLevel(user.tenantId, p.levelId);
        if (!p.sharePolicy) policy = (level.defaultSharePolicy as SharePolicy) || 'designated_only';
        minRank = level.minCustomerRank ?? 0;
      } catch {
        /* keep defaults */
      }
      const rec = { policy, minRank };
      levelCache.set(key, rec);
      return rec;
    };
    const visible: ProductRec[] = [];
    for (const p of items) {
      const { policy, minRank } = await resolveLevel(p);
      if (opts?.publicOnly && policy !== 'open') continue;
      const verdict = this.access.canView(user, {
        productId: p.id,
        sharePolicy: policy,
        minCustomerRank: minRank,
        viaShareEventId: opts?.shareEventId,
        boundCustomerId: opts?.boundCustomerId,
        boundCustomerIds: boundIds,
      });
      if (!verdict.ok) continue;
      visible.push(p);
    }
    if (!visible.length) return { items: [], total: 0 };
    const [coverMap, skuMap] = await Promise.all([
      this.batchFirstCoverUrls(user.tenantId, visible),
      this.repo.listSkusByProductIds(
        user.tenantId,
        visible.map((p) => p.id),
      ),
    ]);
    const out = visible.map((p) => {
      const dto = this.toPublicDto(p, skuMap.get(p.id) || [], true);
      const { skus: _skus, ...rest } = dto as typeof dto & { skus?: unknown };
      return { ...rest, coverUrl: coverMap.get(p.id) || '' };
    });
    return { items: out, total: out.length };
  }

  /** Light existence+ACL check without resolving images (listSets / promo polls). */
  async assertProductReadable(
    user: AuthContext,
    productId: string,
    opts?: { shareEventId?: string; boundCustomerId?: string; boundCustomerIds?: string[] },
  ) {
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    if (user.role === 'owner' || user.role === 'staff') return p;
    const policy = await this.resolveSharePolicy(user.tenantId, p);
    const minRank = await this.resolveMinRank(user.tenantId, p);
    const boundIds = await this.resolveShareBoundIds(
      user.tenantId,
      opts?.shareEventId,
      opts?.boundCustomerIds,
      opts?.boundCustomerId,
    );
    const verdict = this.access.canView(user, {
      productId: p.id,
      sharePolicy: policy,
      minCustomerRank: minRank,
      viaShareEventId: opts?.shareEventId,
      boundCustomerId: opts?.boundCustomerId,
      boundCustomerIds: boundIds,
    });
    if (!verdict.ok) throw new ForbiddenException(`无权查看该商品: ${verdict.reason}`);
    return p;
  }

  async getDetail(
    user: AuthContext,
    productId: string,
    opts?: {
      shareEventId?: string;
      boundCustomerId?: string;
      boundCustomerIds?: string[];
      ruleEffect?: 'allow' | 'deny' | null;
    },
  ) {
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    const skus = await this.repo.listSkus(user.tenantId, productId);
    if (user.role === 'owner' || user.role === 'staff') {
      void this.recordView(user, productId, 'ok', opts?.shareEventId);
      const staffDto = await this.withImages(user.tenantId, p, this.toStaffDto(p, skus));
      staffDto.allowCustomerDownload = await this.resolveAllowCustomerDownload(user.tenantId);
      return staffDto;
    }
    const policy = await this.resolveSharePolicy(user.tenantId, p);
    const minRank = await this.resolveMinRank(user.tenantId, p);
    const boundIds = await this.resolveShareBoundIds(
      user.tenantId,
      opts?.shareEventId,
      opts?.boundCustomerIds,
      opts?.boundCustomerId,
    );
    const verdict = this.access.canView(user, {
      productId: p.id,
      sharePolicy: policy,
      minCustomerRank: minRank,
      ruleEffect: opts?.ruleEffect ?? null,
      viaShareEventId: opts?.shareEventId,
      boundCustomerId: opts?.boundCustomerId,
      boundCustomerIds: boundIds,
    });
    if (!verdict.ok) {
      void this.recordView(user, productId, 'denied', opts?.shareEventId);
      throw new ForbiddenException(`无权查看该商品: ${verdict.reason}`);
    }
    void this.recordView(user, productId, 'ok', opts?.shareEventId);
    const pubDto = await this.withImages(user.tenantId, p, this.toPublicDto(p, skus, true));
    pubDto.allowCustomerDownload = await this.resolveAllowCustomerDownload(user.tenantId);
    return pubDto;
  }

  /** 访问日志（异步写入，失败不影响主路径） */
  private async recordView(
    user: AuthContext,
    productId: string,
    result: 'ok' | 'denied',
    shareEventId?: string,
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return;
    try {
      const repo = this.dataSource.getRepository(ProductViewEvent);
      await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId,
          customerId: user.customerId || null,
          memberId: user.memberId || null,
          shareEventId: shareEventId || null,
          viewerRole: user.role || 'anonymous',
          result,
        }),
      );
    } catch (e: any) {
      this.logger.warn(`recordView failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  /** 管理员：商品访问日志（最近 N 条） */
  async listViews(user: AuthContext, productId: string, limit = 50) {
    this.assertStaff(user);
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { items: [], total: 0 };
    }
    const repo = this.dataSource.getRepository(ProductViewEvent);
    const take = Math.min(100, Math.max(1, limit));
    const [rows, total] = await repo.findAndCount({
      where: { tenantId: user.tenantId, productId },
      order: { createdAt: 'DESC' },
      take,
    });
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        customerId: r.customerId,
        memberId: r.memberId,
        shareEventId: r.shareEventId,
        viewerRole: r.viewerRole,
        result: r.result,
        createdAt: r.createdAt?.getTime?.() ?? r.createdAt,
      })),
    };
  }

  /** 管理员：某客户访问过的商品（product_view_events，按最近访问去重） */
  async listCustomerViewedProducts(user: AuthContext, customerId: string, limit = 50) {
    this.assertStaff(user);
    if (!customerId) throw new BadRequestException('customerId 必填');
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { items: [] as Array<{
        productId: string;
        productName: string | null;
        styleNo: string | null;
        lastViewedAt: number | Date;
        viewCount: number;
      }> };
    }
    const take = Math.min(100, Math.max(1, limit));
    const rows = await this.dataSource
      .getRepository(ProductViewEvent)
      .createQueryBuilder('v')
      .select('v.product_id', 'productId')
      .addSelect('MAX(v.created_at)', 'lastViewedAt')
      .addSelect('COUNT(*)', 'viewCount')
      .where('v.tenant_id = :tenantId', { tenantId: user.tenantId })
      .andWhere('v.customer_id = :customerId', { customerId })
      .andWhere("v.result = 'ok'")
      .groupBy('v.product_id')
      .orderBy('lastViewedAt', 'DESC')
      .limit(take)
      .getRawMany<{ productId: string; lastViewedAt: Date; viewCount: string }>();

    if (!rows.length) return { items: [] };

    const ids = rows.map((r) => r.productId);
    const products = await this.dataSource
      .getRepository(Product)
      .createQueryBuilder('p')
      .select(['p.id', 'p.name', 'p.styleNo'])
      .where('p.tenant_id = :tenantId AND p.id IN (:...ids)', {
        tenantId: user.tenantId,
        ids,
      })
      .getMany();
    const nameMap = new Map(products.map((p) => [p.id, p]));

    return {
      items: rows.map((r) => {
        const p = nameMap.get(r.productId);
        const t = r.lastViewedAt;
        const ms = t instanceof Date ? t.getTime() : new Date(t as any).getTime();
        return {
          productId: r.productId,
          productName: p?.name ?? null,
          styleNo: p?.styleNo ?? null,
          lastViewedAt: Number.isFinite(ms) ? ms : t,
          viewCount: Number(r.viewCount) || 0,
        };
      }),
    };
  }

  /** 发品 analyze：按款号取已有商品颜色 SKU（无则 null） */
  async findByStyleNoWithColors(tenantId: string, styleNo: string) {
    const p = await this.repo.findByStyleNo(tenantId, styleNo.trim());
    if (!p) return null;
    const skus = await this.repo.listSkus(tenantId, p.id);
    const colors = [
      ...new Set(
        skus
          .map((s) => (s.color || '').trim())
          .filter(Boolean),
      ),
    ];
    return {
      styleNo: p.styleNo,
      sellerSku: p.styleNo,
      name: p.name,
      material: p.material,
      colors,
    };
  }

  async create(user: AuthContext, input: CreateProductInput) {
    this.assertStaff(user);
    this.validateProductInput(input);
    const exists = await this.repo.findByStyleNo(user.tenantId, input.styleNo.trim());
    if (exists) throw new ConflictException('款号在本租户内已存在');
    await this.levels.getProductLevel(user.tenantId, input.levelId);
    let groupId = input.groupId;
    if (!groupId) {
      try {
        groupId = await this.groups.getLatestGroupId(user.tenantId);
      } catch {
        groupId = null;
      }
    }
    const created = await this.repo.create(user.tenantId, { ...input, groupId: groupId || null });
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.create',
      targetType: 'product',
      targetId: created.id,
      detail: { styleNo: created.styleNo, name: created.name, status: created.status, groupId: created.groupId || null },
    });
    const skus = await this.repo.listSkus(user.tenantId, created.id);
    return this.toStaffDto(created, skus);
  }

  async update(user: AuthContext, id: string, input: UpdateProductInput) {
    this.assertStaff(user);
    if (!(input as any).styleNo && (input as any).sellerSku) {
      (input as any).styleNo = String((input as any).sellerSku).trim();
    }
    if (input.styleNo) {
      const clash = await this.repo.findByStyleNo(user.tenantId, input.styleNo.trim());
      if (clash && clash.id !== id) throw new ConflictException('款号在本租户内已存在');
    }
    if (input.levelId) {
      await this.levels.getProductLevel(user.tenantId, input.levelId);
    }
    // 待补全商品补录保存：清除 needReview / 待补信息 / provisionalStyleNo / review:* 标记
    let clearedReviewTags = false;
    if ((input as any).clearReviewTags) {
      const cur = await this.repo.findById(user.tenantId, id);
      if (!cur) throw new NotFoundException('商品不存在');
      const cleaned = (((cur as any).tags as string[]) || []).filter(
        (t) =>
          t !== 'needReview' &&
          t !== 'provisionalStyleNo' &&
          t !== '待补信息' &&
          !String(t).startsWith('review:'),
      );
      (input as any).tags = cleaned;
      delete (input as any).clearReviewTags;
      clearedReviewTags = true;
    }
    if (input.coverMediaIds) {
      const existing = await this.repo.findById(user.tenantId, id);
      if (!existing) throw new NotFoundException('商品不存在');
      input = {
        ...input,
        coverMediaIds: await this.sanitizeCoverMediaIds(
          user.tenantId,
          id,
          input.coverMediaIds,
          existing.coverMediaIds || [],
        ),
      };
    }
    const updated = await this.repo.update(user.tenantId, id, input);
    if (!updated) throw new NotFoundException('商品不存在');
    // 待补全任务闭环：补录保存成功后，任务中心对应任务转「已完成」
    if (clearedReviewTags) {
      const newStyleNo = String((input as any).styleNo || '').trim();
      await this.jobs.markPendingCompletionsDone(user.tenantId, id, newStyleNo || null);
    }
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.update',
      targetType: 'product',
      targetId: id,
      detail: { fields: Object.keys(input || {}) },
    });
    const skus = await this.repo.listSkus(user.tenantId, id);
    return this.withImages(user.tenantId, updated, this.toStaffDto(updated, skus));
  }

  /**
   * 按颜色列表整体替换/对齐 SKU（一色一价，size=null）。
   * 同色更新 in-place；缺的新增（优先 revive 软删行）；多余的软删并释放 uk_sku。
   * 避免「全删再插」撞 product_skus.uk_sku。
   */
  async replaceColorSkus(
    user: AuthContext,
    productId: string,
    skus: Array<{ color: string; price?: string | null }>,
  ) {
    this.assertStaff(user);
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    const colors = skus.map((s) => (s.color || '').trim()).filter(Boolean);
    if (!colors.length) throw new BadRequestException('至少保留一个颜色 SKU');
    if (new Set(colors).size !== colors.length) {
      throw new BadRequestException('颜色名不能重复');
    }
    const existing = await this.repo.listSkus(user.tenantId, productId);
    const byColor = new Map<string, (typeof existing)[number]>();
    for (const s of existing) {
      const c = (s.color || '').trim();
      if (c && !byColor.has(c)) byColor.set(c, s);
    }
    const kept: Awaited<ReturnType<IProductsRepository['addSku']>>[] = [];
    const usedIds = new Set<string>();
    for (const s of skus) {
      const color = s.color.trim();
      const price =
        s.price != null && String(s.price).trim() !== '' ? String(s.price).trim() : null;
      const skuCode = `${p.styleNo}-${color}`;
      const payload = {
        color,
        size: null as string | null,
        price,
        stock: 0,
        status: 'active' as const,
        skuCode,
      };
      const old = byColor.get(color);
      if (old) {
        const updated = await this.repo.updateSku(user.tenantId, old.id, payload);
        if (updated) kept.push(updated);
        usedIds.add(old.id);
        continue;
      }
      const revived = await this.repo.reviveSkuByCode(
        user.tenantId,
        productId,
        skuCode,
        payload,
      );
      if (revived) {
        kept.push(revived);
        usedIds.add(revived.id);
        continue;
      }
      kept.push(await this.repo.addSku(user.tenantId, productId, payload));
    }
    for (const s of existing) {
      if (!usedIds.has(s.id)) {
        await this.repo.removeSku(user.tenantId, s.id);
      }
    }
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.sku.replace_colors',
      targetType: 'product',
      targetId: productId,
      detail: { colors: kept.map((k) => k.color), count: kept.length },
    });
    return kept;
  }

  /** 删除=下架 */
  async remove(user: AuthContext, id: string) {
    this.assertStaff(user);
    const updated = await this.repo.softOffSale(user.tenantId, id);
    if (!updated) throw new NotFoundException('商品不存在');
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.off_sale',
      targetType: 'product',
      targetId: id,
      detail: { status: updated.status, via: 'remove' },
    });
    return { ok: true, id, status: updated.status };
  }

  async batchStatus(user: AuthContext, ids: string[], status: 'on_sale' | 'off_sale') {
    this.assertStaff(user);
    if (!ids?.length) throw new BadRequestException('ids 不能为空');
    if (status !== 'on_sale' && status !== 'off_sale') {
      throw new BadRequestException('status 仅支持 on_sale / off_sale');
    }
    const n = await this.repo.batchSetStatus(user.tenantId, ids, status);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: status === 'on_sale' ? 'product.batch_on_sale' : 'product.batch_off_sale',
      targetType: 'product',
      targetId: ids[0] || null,
      detail: { ids, affected: n, status },
    });
    return { ok: true, affected: n, status };
  }

  async copy(user: AuthContext, id: string, body?: { styleNo?: string }) {
    this.assertStaff(user);
    const src = await this.repo.findById(user.tenantId, id);
    if (!src) throw new NotFoundException('商品不存在');
    const newStyleNo = (body?.styleNo || `${src.styleNo}-COPY`).trim();
    const clash = await this.repo.findByStyleNo(user.tenantId, newStyleNo);
    if (clash) throw new ConflictException('目标款号已存在');
    const copied = await this.repo.copy(user.tenantId, id, newStyleNo);
    if (!copied) throw new NotFoundException('复制失败');
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.copy',
      targetType: 'product',
      targetId: copied.id,
      detail: { fromId: id, styleNo: copied.styleNo },
    });
    const skus = await this.repo.listSkus(user.tenantId, copied.id);
    return this.toStaffDto(copied, skus);
  }

  async addSku(user: AuthContext, productId: string, input: CreateSkuInput) {
    this.assertStaff(user);
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    const existing = await this.repo.listSkus(user.tenantId, productId);
    // 一色一 SKU：编码 款号-颜色；尺码不进 SKU
    const code =
      input.skuCode?.trim() ||
      `${p.styleNo}-${input.color || 'NA'}`;
    if (existing.some((s) => s.skuCode === code)) {
      throw new ConflictException('SKU 编码已存在');
    }
    const sku = await this.repo.addSku(user.tenantId, productId, { ...input, skuCode: code });
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.sku.create',
      targetType: 'product_sku',
      targetId: sku.id,
      detail: { productId, skuCode: sku.skuCode, color: sku.color },
    });
    return sku;
  }

  async updateSku(user: AuthContext, productId: string, skuId: string, input: Partial<CreateSkuInput>) {
    this.assertStaff(user);
    const sku = await this.repo.findSku(user.tenantId, skuId);
    if (!sku || sku.productId !== productId) throw new NotFoundException('SKU 不存在');
    if (input.skuCode) {
      const existing = await this.repo.listSkus(user.tenantId, productId);
      if (existing.some((s) => s.skuCode === input.skuCode!.trim() && s.id !== skuId)) {
        throw new ConflictException('SKU 编码已存在');
      }
    }
    const updated = await this.repo.updateSku(user.tenantId, skuId, input);
    if (!updated) throw new NotFoundException('SKU 不存在');
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.sku.update',
      targetType: 'product_sku',
      targetId: skuId,
      detail: { productId, fields: Object.keys(input || {}) },
    });
    return updated;
  }

  async removeSku(user: AuthContext, productId: string, skuId: string) {
    this.assertStaff(user);
    const sku = await this.repo.findSku(user.tenantId, skuId);
    if (!sku || sku.productId !== productId) throw new NotFoundException('SKU 不存在');
    await this.repo.removeSku(user.tenantId, skuId);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.sku.delete',
      targetType: 'product_sku',
      targetId: skuId,
      detail: { productId },
    });
    return { ok: true };
  }

  /** 编辑页：追加商品图（multipart 已由 controller 解析） */
  async addImages(user: AuthContext, productId: string, files: Express.Multer.File[]) {
    this.assertStaff(user);
    if (!files?.length) throw new BadRequestException('请至少上传一张图片');
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('需开启数据库');
    }
    const repo = this.dataSource.getRepository(MediaAsset);
    const styleDir = path.join(this.storageRoot(), 'tenants', user.tenantId, 'products', p.styleNo);
    fs.mkdirSync(styleDir, { recursive: true });
    const existing = await this.resolveImages(user.tenantId, p);
    let seq = existing.length;
    const addedIds: string[] = [];
    for (const file of files) {
      seq += 1;
      const mime = file.mimetype || 'image/jpeg';
      const ext =
        path.extname(file.originalname || '') ||
        (mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg');
      const safeName = `${String(seq).padStart(2, '0')}_${Date.now()}${ext}`;
      const localPath = path.join(styleDir, safeName);
      fs.writeFileSync(localPath, file.buffer);
      const objectKey = `tenants/${user.tenantId}/products/${p.styleNo}/${safeName}`;
      await this.oss.putObjectSafe(file.buffer, objectKey, mime);
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId,
          type: 'image',
          provider: this.oss.mediaProvider(),
          objectKey,
          mimeType: mime,
          sizeBytes: String(file.size || file.buffer.length),
          status: 'active',
        }),
      );
      addedIds.push(saved.id);
    }
    const coverMediaIds = [...(p.coverMediaIds || []), ...addedIds];
    const updated = await this.repo.update(user.tenantId, productId, { coverMediaIds });
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.image.add',
      targetType: 'product',
      targetId: productId,
      detail: { mediaIds: addedIds, count: addedIds.length },
    });
    const skus = await this.repo.listSkus(user.tenantId, productId);
    return this.withImages(user.tenantId, updated!, this.toStaffDto(updated!, skus));
  }

  /** 编辑页：删除一张商品图（从 coverMediaIds 移除；宣传成片只摘链不软删） */
  async removeImage(user: AuthContext, productId: string, mediaId: string) {
    this.assertStaff(user);
    const p = await this.repo.findById(user.tenantId, productId);
    if (!p) throw new NotFoundException('商品不存在');
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      const repo = this.dataSource.getRepository(MediaAsset);
      const row = await repo.findOne({ where: { id: mediaId, tenantId: user.tenantId } });
      if (row && (row.productId === productId || (p.coverMediaIds || []).includes(mediaId))) {
        // 宣传图/视频仍挂在 promo_sets，编辑页移除只摘 cover，不删资产
        if (!this.isPromoAsset(row)) {
          row.status = 'deleted';
          await repo.save(row);
        }
      }
    }
    const coverMediaIds = (p.coverMediaIds || []).filter((id) => id !== mediaId);
    const updated = await this.repo.update(user.tenantId, productId, { coverMediaIds });
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product.image.remove',
      targetType: 'media_asset',
      targetId: mediaId,
      detail: { productId },
    });
    const skus = await this.repo.listSkus(user.tenantId, productId);
    return this.withImages(user.tenantId, updated!, this.toStaffDto(updated!, skus));
  }

  private assertStaff(user: AuthContext) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('仅员工可操作');
    }
  }

  private validateProductInput(input: CreateProductInput) {
    const styleNo = (input.styleNo || (input as any).sellerSku || '').trim();
    if (!styleNo) throw new BadRequestException('款号必填');
    input.styleNo = styleNo;
    if (!input.name?.trim()) throw new BadRequestException('名称必填');
    if (!input.levelId) throw new BadRequestException('商品等级必填');
  }


  /**
   * 经分享入口访问时，由服务端解析名额占用名单，不信任客户端伪造的 boundCustomerId。
   * openShare 已占名额后，详情页带 shareEventId 即可。
   */
  private async resolveShareBoundIds(
    tenantId: string,
    shareEventId: string | undefined,
    fallbackIds?: string[] | null,
    fallbackSingle?: string | null,
  ): Promise<string[] | undefined> {
    if (!shareEventId) {
      if (fallbackIds && fallbackIds.length) return fallbackIds;
      if (fallbackSingle) return [fallbackSingle];
      return undefined;
    }
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      try {
        const rows = await this.dataSource.getRepository(ShareEventBinding).find({
          where: { tenantId, shareEventId },
          order: { boundAt: 'ASC' },
        });
        if (rows.length) return rows.map((r) => r.customerId);
        // 兼容尚未回填的旧行：读 share_events.bound_customer_id
        const ev = await this.dataSource.getRepository(ShareEvent).findOne({
          where: { id: shareEventId, tenantId },
        });
        if (ev?.boundCustomerId) return [ev.boundCustomerId];
        return [];
      } catch (e: any) {
        this.logger.warn(`resolveShareBoundIds failed: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    if (fallbackIds && fallbackIds.length) return fallbackIds;
    if (fallbackSingle) return [fallbackSingle];
    return undefined;
  }

  private async resolveSharePolicy(tenantId: string, p: ProductRec): Promise<SharePolicy> {
    if (p.sharePolicy) return p.sharePolicy;
    try {
      const level = await this.levels.getProductLevel(tenantId, p.levelId);
      return (level.defaultSharePolicy as SharePolicy) || 'designated_only';
    } catch {
      return 'designated_only';
    }
  }

  private async resolveMinRank(tenantId: string, p: ProductRec): Promise<number> {
    try {
      const level = await this.levels.getProductLevel(tenantId, p.levelId);
      return level.minCustomerRank ?? 0;
    } catch {
      return 0;
    }
  }

  private pickPrice(skus: { price: string | null }[]) {
    const prices = skus.map((s) => s.price).filter((x): x is string => !!x);
    return prices[0] || null;
  }

  /** 员工端价签：有 SKU 价显示 ¥最低价 起；全无价才「未标价」 */
  private formatStaffPriceText(skus: { price: string | null }[]) {
    const nums = skus
      .map((s) => (s.price == null || s.price === '' ? NaN : Number(s.price)))
      .filter((n) => Number.isFinite(n));
    if (!nums.length) return '未标价';
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
    if (min === max) return `¥${fmt(min)}`;
    return `¥${fmt(min)} 起`;
  }


  /** 客户可见标签：去掉发品内部标记（needReview / review:* / provisionalStyleNo / 识别中） */
  private publicTags(tags: string[] | null | undefined): string[] {
    return (tags || []).filter((t) => {
      if (t == null) return false;
      const s = String(t).trim();
      if (!s) return false;
      if (s === 'needReview' || s === 'provisionalStyleNo' || s === '识别中') return false;
      if (s.startsWith('review:')) return false;
      return true;
    });
  }

  private toStaffDto(p: ProductRec, skus: Awaited<ReturnType<IProductsRepository['listSkus']>>) {
    const activeSkus = skus.filter((s) => s.status === 'active');
    const price = this.pickPrice(activeSkus.length ? activeSkus : skus);
    return {
      id: p.id,
      styleNo: p.styleNo,
      sellerSku: p.styleNo,
      name: p.name,
      description: p.description,
      material: p.material,
      levelId: p.levelId,
      groupId: p.groupId || null,
      priceDisplay: p.priceDisplay,
      sharePolicy: p.sharePolicy,
      allowCustomerDownload: !!p.allowCustomerDownload,
      tags: p.tags || [],
      status: p.status,
      sortOrder: p.sortOrder,
      coverMediaIds: p.coverMediaIds || [],
      mediaIds: p.coverMediaIds || [],
      priceText: this.formatStaffPriceText(activeSkus.length ? activeSkus : skus),
      price,
      colorCount: (activeSkus.length ? activeSkus : skus).length,
      skus,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private toPublicDto(
    p: ProductRec,
    skus: Awaited<ReturnType<IProductsRepository['listSkus']>>,
    _maskPrice: boolean,
  ) {
    const active = skus.filter((s) => s.status === 'active');
    const price = this.pickPrice(active.length ? active : skus);
    const showPrice = p.priceDisplay === 'show';
    let priceText = '询价';
    if (showPrice) {
      priceText = this.formatStaffPriceText(active.length ? active : skus);
      if (priceText === '未标价') priceText = '询价';
    }
    return {
      id: p.id,
      styleNo: p.styleNo,
      sellerSku: p.styleNo,
      name: p.name,
      description: p.description,
      material: p.material,
      groupId: p.groupId || null,
      priceDisplay: p.priceDisplay,
      priceText,
      price: showPrice ? price : null,
      sharePolicy: p.sharePolicy,
      allowCustomerDownload: !!p.allowCustomerDownload,
      status: p.status,
      tags: this.publicTags(p.tags),
      mediaIds: (p.coverMediaIds || []) as string[],
      skus: skus
        .filter((s) => s.status === 'active')
        .map((s) => ({
          id: s.id,
          skuCode: s.skuCode,
          color: s.color,
          size: s.size,
          price: showPrice ? s.price : null,
          stock: s.stock,
        })),
    };
  }
}
