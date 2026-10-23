import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ShareEvent } from '../common/entities/share-event.entity';
import { ShareEventBinding } from '../common/entities/share-event-binding.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { ProductAccessService, SharePolicy } from '../products/product-access.service';
import { ProductsService } from '../products/products.service';
import { CustomersService } from '../customers/customers.service';

export interface ShareRecord {
  id: string;
  tenantId: string;
  productId: string;
  creatorMemberId: string;
  sharePolicy: SharePolicy;
  slotLimit: number;
  boundCustomerId: string | null;
  boundAt: Date | null;
  status: string;
  createdAt: Date;
  /** 内存模式：已占用名额的客户 id */
  boundCustomerIds?: string[];
}

function defaultSlotLimit(): number {
  const n = parseInt(process.env.SHARE_LIMIT_SLOTS || '5', 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 100);
}

/**
 * 分享服务：
 * 1. 业主/员工创建分享时不必先选客户（不做微信/客户列表定向）
 * 2. designated_only（限制分享）：前 N 位成功打开链接的客户占用名额；其后拒绝
 * 3. open（公开分享）：不占名额、无人数上限
 */
@Injectable()
export class SharesService {
  private readonly shares = new Map<string, ShareRecord>();
  private seq = 1;

  constructor(
    private readonly access: ProductAccessService,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    @Optional() private readonly ds?: DataSource,
  ) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private toRec(e: ShareEvent, boundIds?: string[]): ShareRecord {
    return {
      id: e.id,
      tenantId: e.tenantId,
      productId: e.productId,
      creatorMemberId: e.creatorMemberId,
      sharePolicy: e.sharePolicy as SharePolicy,
      slotLimit: e.slotLimit ?? defaultSlotLimit(),
      boundCustomerId: e.boundCustomerId,
      boundAt: e.boundAt,
      status: e.status,
      createdAt: e.createdAt,
      boundCustomerIds: boundIds,
    };
  }

  private async loadBindings(tenantId: string, shareId: string): Promise<string[]> {
    if (this.db) {
      const rows = await this.db.getRepository(ShareEventBinding).find({
        where: { tenantId, shareEventId: shareId },
        order: { boundAt: 'ASC' },
      });
      return rows.map((r) => r.customerId);
    }
    const r = this.shares.get(shareId);
    return r && r.tenantId === tenantId ? [...(r.boundCustomerIds || [])] : [];
  }

  private async load(tenantId: string, shareId: string): Promise<ShareRecord | null> {
    if (this.db) {
      const e = await this.db.getRepository(ShareEvent).findOne({ where: { id: shareId, tenantId } });
      if (!e) return null;
      const ids = await this.loadBindings(tenantId, shareId);
      return this.toRec(e, ids);
    }
    const r = this.shares.get(shareId);
    return r && r.tenantId === tenantId ? r : null;
  }

  /** 供商品详情鉴权：返回某分享已占用名额的客户 id 列表 */
  async listBoundCustomerIds(tenantId: string, shareId: string): Promise<string[]> {
    const share = await this.load(tenantId, shareId);
    if (!share) return [];
    if (share.boundCustomerIds && share.boundCustomerIds.length) return share.boundCustomerIds;
    return this.loadBindings(tenantId, shareId);
  }

  async getShareMeta(tenantId: string, shareId: string): Promise<{
    sharePolicy: SharePolicy;
    slotLimit: number;
    boundCustomerIds: string[];
    productId: string;
  } | null> {
    const share = await this.load(tenantId, shareId);
    if (!share) return null;
    const ids = share.boundCustomerIds || (await this.loadBindings(tenantId, shareId));
    return {
      sharePolicy: share.sharePolicy,
      slotLimit: share.slotLimit,
      boundCustomerIds: ids,
      productId: share.productId,
    };
  }

  /**
   * 尝试占用一个限制分享名额（原子）：
   * - 已在名单中 → 视为成功（boundNow=false）
   * - 名额未满 → 插入；并发下以唯一键 + 再次计数为准
   * - 名额已满且不在名单 → 失败
   */
  private async claimSlot(
    share: ShareRecord,
    customerId: string,
  ): Promise<{ ok: boolean; boundNow: boolean; ids: string[]; reason?: string }> {
    const limit = share.slotLimit || defaultSlotLimit();

    if (this.db) {
      const repo = this.db.getRepository(ShareEventBinding);
      const existing = await repo.findOne({
        where: { shareEventId: share.id, customerId, tenantId: share.tenantId },
      });
      if (existing) {
        const ids = await this.loadBindings(share.tenantId, share.id);
        return { ok: true, boundNow: false, ids };
      }

      const count = await repo.count({ where: { shareEventId: share.id, tenantId: share.tenantId } });
      if (count >= limit) {
        const ids = await this.loadBindings(share.tenantId, share.id);
        return { ok: false, boundNow: false, ids, reason: 'slots_full' };
      }

      const now = new Date();
      try {
        await repo.insert({
          id: randomUUID(),
          tenantId: share.tenantId,
          shareEventId: share.id,
          customerId,
          boundAt: now,
        });
      } catch (e: any) {
        // 并发重复插入同一客户：视为已占用
        const again = await repo.findOne({
          where: { shareEventId: share.id, customerId, tenantId: share.tenantId },
        });
        if (again) {
          const ids = await this.loadBindings(share.tenantId, share.id);
          return { ok: true, boundNow: false, ids };
        }
        // 可能是名额被别人抢完：再数一次
        const ids = await this.loadBindings(share.tenantId, share.id);
        if (ids.length >= limit && !ids.includes(customerId)) {
          return { ok: false, boundNow: false, ids, reason: 'slots_full' };
        }
        throw e;
      }

      // 插入后再校验：若并发超限，撤销本次并拒绝
      const idsAfter = await this.loadBindings(share.tenantId, share.id);
      if (idsAfter.length > limit && idsAfter[idsAfter.length - 1] === customerId) {
        // 简单策略：若总数超限且当前客户不是前 limit 位，删除并拒绝
        const keep = new Set(idsAfter.slice(0, limit));
        if (!keep.has(customerId)) {
          await repo.delete({ shareEventId: share.id, customerId, tenantId: share.tenantId });
          return { ok: false, boundNow: false, ids: idsAfter.slice(0, limit), reason: 'slots_full' };
        }
      }

      // 兼容字段：首位写入 bound_customer_id
      if (!share.boundCustomerId) {
        await this.db
          .getRepository(ShareEvent)
          .createQueryBuilder()
          .update(ShareEvent)
          .set({ boundCustomerId: customerId, boundAt: now })
          .where('id = :id AND tenant_id = :tid AND bound_customer_id IS NULL', {
            id: share.id,
            tid: share.tenantId,
          })
          .execute();
      }

      const ids = await this.loadBindings(share.tenantId, share.id);
      return { ok: true, boundNow: true, ids };
    }

    // 内存模式
    const ids = share.boundCustomerIds || [];
    if (ids.includes(customerId)) return { ok: true, boundNow: false, ids };
    if (ids.length >= limit) return { ok: false, boundNow: false, ids, reason: 'slots_full' };
    ids.push(customerId);
    share.boundCustomerIds = ids;
    if (!share.boundCustomerId) {
      share.boundCustomerId = customerId;
      share.boundAt = new Date();
    }
    this.shares.set(share.id, share);
    return { ok: true, boundNow: true, ids };
  }

  /** 创建分享：限制分享 / 公开分享；不预先选客户 */
  async createShare(
    user: AuthContext,
    body: { productId: string; sharePolicy?: SharePolicy; slotLimit?: number },
  ) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('仅业主/员工可创建分享');
    }
    await this.products.getDetail(user, body.productId);
    const policy = body.sharePolicy || 'designated_only';
    const slotLimit =
      policy === 'designated_only'
        ? Math.min(Math.max(Number(body.slotLimit) || defaultSlotLimit(), 1), 100)
        : 0;

    let rec: ShareRecord;
    if (this.db) {
      const repo = this.db.getRepository(ShareEvent);
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId: body.productId,
          creatorMemberId: user.memberId || 'unknown',
          sharePolicy: policy,
          slotLimit: slotLimit || defaultSlotLimit(),
          boundCustomerId: null,
          boundAt: null,
          expiresAt: null,
          status: 'active',
        }),
      );
      rec = this.toRec(saved, []);
    } else {
      rec = {
        id: `share_${String(this.seq++).padStart(6, '0')}`,
        tenantId: user.tenantId,
        productId: body.productId,
        creatorMemberId: user.memberId || 'unknown',
        sharePolicy: policy,
        slotLimit: slotLimit || defaultSlotLimit(),
        boundCustomerId: null,
        boundAt: null,
        status: 'active',
        createdAt: new Date(),
        boundCustomerIds: [],
      };
      this.shares.set(rec.id, rec);
    }
    return {
      shareId: rec.id,
      productId: rec.productId,
      sharePolicy: rec.sharePolicy,
      slotLimit: policy === 'designated_only' ? rec.slotLimit : null,
      path: `/pages/share/landing/landing?shareId=${rec.id}`,
    };
  }

  /**
   * 打开分享落地：
   * - 公开：建档后放行
   * - 限制：占用名额（前 N 位）或已占用者放行；名额满拒绝
   */
  async openShare(user: AuthContext, shareId: string) {
    let share = await this.load(user.tenantId, shareId);
    if (!share) {
      throw new NotFoundException('分享不存在');
    }
    if (share.status !== 'active') {
      throw new ForbiddenException('分享已失效');
    }

    if (user.role === 'owner' || user.role === 'staff') {
      const product = await this.products.getDetail(user, share.productId);
      const ids = share.boundCustomerIds || (await this.loadBindings(share.tenantId, share.id));
      return {
        share: this.shareDto(share, ids),
        product,
        bound: ids.length > 0,
        access: 'staff',
      };
    }

    const customer = await this.customers.ensureProfile(user);
    let boundIds = share.boundCustomerIds || (await this.loadBindings(share.tenantId, share.id));

    if (share.sharePolicy === 'designated_only') {
      const claim = await this.claimSlot(share, customer.id);
      boundIds = claim.ids;
      if (!claim.ok) {
        throw new ForbiddenException(
          `该限制分享名额已满（仅前 ${share.slotLimit || defaultSlotLimit()} 位打开链接的客户可查看）`,
        );
      }
      if (claim.boundNow) {
        await this.customers.markFirstShare(customer.id, shareId, share.tenantId);
      }
      share = (await this.load(user.tenantId, shareId)) || share;
    } else {
      // 公开分享：不占名额；ensureProfile 已建档，仅记首次分享（幂等）
      await this.customers.markFirstShare(customer.id, shareId, share.tenantId);
    }

    const verdict = this.access.canView(user, {
      productId: share.productId,
      sharePolicy: share.sharePolicy,
      viaShareEventId: shareId,
      boundCustomerIds: boundIds,
      boundCustomerId: share.boundCustomerId,
    });

    if (share.sharePolicy === 'designated_only') {
      if (!boundIds.includes(customer.id)) {
        throw new ForbiddenException(
          `该限制分享名额已满（仅前 ${share.slotLimit || defaultSlotLimit()} 位打开链接的客户可查看）`,
        );
      }
    } else if (!verdict.ok && verdict.reason !== 'awaiting_bind') {
      throw new ForbiddenException(`无权查看: ${verdict.reason}`);
    }

    const product = await this.products.getDetail(
      { ...user, customerId: customer.id, role: 'customer' },
      share.productId,
      {
        shareEventId: shareId,
        boundCustomerId: customer.id,
        boundCustomerIds: boundIds,
      },
    );

    return {
      share: this.shareDto(share, boundIds),
      product,
      customerId: customer.id,
      access: 'granted',
    };
  }

  private shareDto(share: ShareRecord, ids: string[]) {
    return {
      id: share.id,
      productId: share.productId,
      sharePolicy: share.sharePolicy,
      slotLimit: share.sharePolicy === 'designated_only' ? share.slotLimit : null,
      slotsUsed: share.sharePolicy === 'designated_only' ? ids.length : null,
      boundCustomerId: share.boundCustomerId,
      boundCustomerIds: share.sharePolicy === 'designated_only' ? ids : undefined,
      boundAt: share.boundAt,
    };
  }

  getShare(tenantId: string, shareId: string) {
    return this.load(tenantId, shareId);
  }
}
