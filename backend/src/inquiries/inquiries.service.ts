import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Inquiry } from '../common/entities/inquiry.entity';
import { Product } from '../common/entities/product.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { CustomersService } from '../customers/customers.service';

export interface InquiryRec {
  id: string;
  tenantId: string;
  productId: string;
  customerId: string;
  content: string;
  phone: string | null;
  contactName: string | null;
  remark: string | null;
  status: string;
  staffReadAt: Date | null;
  handledNote: string | null;
  unread: boolean;
  productName?: string | null;
  createdAt: Date;
}

export type CreateInquiryBody = {
  productId: string;
  /** 手机（与 name 至少一个） */
  phone?: string;
  /** 姓名/称呼，写入 contact_name 并回写 customer_profiles.nickname */
  name?: string;
  nickname?: string;
  remark?: string;
  /** 兼容旧客户端：纯文字询价 */
  content?: string;
};

export type CustomerInquiryStat = {
  customerId: string;
  inquiryCount: number;
  unreadCount: number;
  hasUnreadInquiry: boolean;
};

export type UnreadSummary = {
  unreadInquiryCount: number;
  customers: CustomerInquiryStat[];
};

/** 询价：关联单商品；可附带联系方式并回写客户档案；员工已读标记 */
@Injectable()
export class InquiriesService {
  private readonly listStore: InquiryRec[] = [];
  private seq = 1;

  constructor(
    @Inject(forwardRef(() => CustomersService))
    private readonly customers: CustomersService,
    @Optional() private readonly ds?: DataSource,
  ) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private assertStaff(user: AuthContext) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('仅员工可操作');
    }
  }

  private toRec(e: Inquiry, productName?: string | null): InquiryRec {
    const staffReadAt = e.staffReadAt ?? null;
    return {
      id: e.id,
      tenantId: e.tenantId,
      productId: e.productId,
      customerId: e.customerId,
      content: e.content,
      phone: e.phone ?? null,
      contactName: e.contactName ?? null,
      remark: e.remark ?? null,
      status: e.status,
      staffReadAt,
      handledNote: e.handledNote ?? null,
      unread: staffReadAt == null,
      productName: productName ?? null,
      createdAt: e.createdAt,
    };
  }

  async create(user: AuthContext, body: CreateInquiryBody) {
    if (!body.productId) throw new BadRequestException('商品必填');
    if (!user.customerId) throw new ForbiddenException('仅客户可发起询价');

    const phone = body.phone != null ? String(body.phone).trim().slice(0, 32) : '';
    const contactName = String(body.name ?? body.nickname ?? '')
      .trim()
      .slice(0, 64);
    const remark = body.remark != null ? String(body.remark).trim().slice(0, 255) : '';
    const legacyContent = body.content != null ? String(body.content).trim() : '';

    if (!phone && !contactName && !legacyContent) {
      throw new BadRequestException('请填写手机号或姓名');
    }

    const content =
      legacyContent ||
      [contactName && `称呼：${contactName}`, phone && `手机：${phone}`, remark && `备注：${remark}`]
        .filter(Boolean)
        .join('；') ||
      '客户询价';

    // 回写客户档案（有填才写）
    const profilePatch: { phone?: string | null; nickname?: string | null } = {};
    if (phone) profilePatch.phone = phone;
    if (contactName) profilePatch.nickname = contactName;
    if (Object.keys(profilePatch).length) {
      await this.customers.updateSelfProfile(user, profilePatch);
    }

    if (this.db) {
      const repo = this.db.getRepository(Inquiry);
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId: body.productId,
          customerId: user.customerId,
          content,
          phone: phone || null,
          contactName: contactName || null,
          remark: remark || null,
          status: 'open',
          assigneeMemberId: null,
          staffReadAt: null,
          handledNote: null,
        }),
      );
      return this.toRec(saved);
    }
    const rec: InquiryRec = {
      id: `inq_${String(this.seq++).padStart(6, '0')}`,
      tenantId: user.tenantId,
      productId: body.productId,
      customerId: user.customerId,
      content,
      phone: phone || null,
      contactName: contactName || null,
      remark: remark || null,
      status: 'open',
      staffReadAt: null,
      handledNote: null,
      unread: true,
      productName: null,
      createdAt: new Date(),
    };
    this.listStore.push(rec);
    return rec;
  }

  async list(
    user: AuthContext,
    opts?: { productId?: string; customerId?: string },
  ) {
    const onlyMine = user.role === 'customer';
    const productId = opts?.productId ? String(opts.productId) : '';
    let customerId = opts?.customerId ? String(opts.customerId) : '';
    if (onlyMine) customerId = user.customerId || '-';
    if (user.role === 'customer' && opts?.customerId && opts.customerId !== user.customerId) {
      throw new ForbiddenException('无权查看他人询价');
    }

    if (this.db) {
      const qb = this.db
        .getRepository(Inquiry)
        .createQueryBuilder('i')
        .where('i.tenant_id = :tenantId', { tenantId: user.tenantId })
        .orderBy('i.created_at', 'DESC');
      if (customerId) qb.andWhere('i.customer_id = :customerId', { customerId });
      if (productId) qb.andWhere('i.product_id = :productId', { productId });
      const rows = await qb.getMany();
      const productIds = [...new Set(rows.map((r) => r.productId))];
      const nameMap = new Map<string, string>();
      if (productIds.length) {
        const products = await this.db
          .getRepository(Product)
          .createQueryBuilder('p')
          .select(['p.id', 'p.name'])
          .where('p.tenant_id = :tenantId AND p.id IN (:...ids)', {
            tenantId: user.tenantId,
            ids: productIds,
          })
          .getMany();
        for (const p of products) nameMap.set(p.id, p.name);
      }
      return rows.map((r) => this.toRec(r, nameMap.get(r.productId) ?? null));
    }
    return this.listStore
      .filter((i) => {
        if (i.tenantId !== user.tenantId) return false;
        if (customerId && i.customerId !== customerId) return false;
        if (productId && i.productId !== productId) return false;
        return true;
      })
      .map((i) => ({ ...i, unread: i.staffReadAt == null }));
  }

  async get(user: AuthContext, id: string) {
    let rec: InquiryRec | null = null;
    if (this.db) {
      const e = await this.db.getRepository(Inquiry).findOne({ where: { id, tenantId: user.tenantId } });
      if (e) {
        let productName: string | null = null;
        const p = await this.db.getRepository(Product).findOne({
          where: { id: e.productId, tenantId: user.tenantId },
          select: ['id', 'name'],
        });
        productName = p?.name ?? null;
        rec = this.toRec(e, productName);
      }
    } else {
      const found = this.listStore.find((i) => i.id === id && i.tenantId === user.tenantId) || null;
      rec = found ? { ...found, unread: found.staffReadAt == null } : null;
    }
    if (!rec || (user.role === 'customer' && rec.customerId !== user.customerId)) {
      throw new NotFoundException('询价不存在');
    }
    return rec;
  }

  /** 未读摘要：Tab 红点总计 + 按客户统计（列表行红点） */
  async unreadSummary(user: AuthContext): Promise<UnreadSummary> {
    this.assertStaff(user);
    if (this.db) {
      const rows = await this.db
        .getRepository(Inquiry)
        .createQueryBuilder('i')
        .select('i.customer_id', 'customerId')
        .addSelect('COUNT(*)', 'inquiryCount')
        .addSelect('SUM(CASE WHEN i.staff_read_at IS NULL THEN 1 ELSE 0 END)', 'unreadCount')
        .where('i.tenant_id = :tenantId', { tenantId: user.tenantId })
        .groupBy('i.customer_id')
        .getRawMany<{ customerId: string; inquiryCount: string; unreadCount: string }>();
      const customers: CustomerInquiryStat[] = rows.map((r) => {
        const inquiryCount = Number(r.inquiryCount) || 0;
        const unreadCount = Number(r.unreadCount) || 0;
        return {
          customerId: r.customerId,
          inquiryCount,
          unreadCount,
          hasUnreadInquiry: unreadCount > 0,
        };
      });
      const unreadInquiryCount = customers.reduce((s, c) => s + c.unreadCount, 0);
      return { unreadInquiryCount, customers };
    }
    const map = new Map<string, CustomerInquiryStat>();
    for (const i of this.listStore) {
      if (i.tenantId !== user.tenantId) continue;
      const cur = map.get(i.customerId) || {
        customerId: i.customerId,
        inquiryCount: 0,
        unreadCount: 0,
        hasUnreadInquiry: false,
      };
      cur.inquiryCount += 1;
      if (i.staffReadAt == null) cur.unreadCount += 1;
      cur.hasUnreadInquiry = cur.unreadCount > 0;
      map.set(i.customerId, cur);
    }
    const customers = [...map.values()];
    return {
      unreadInquiryCount: customers.reduce((s, c) => s + c.unreadCount, 0),
      customers,
    };
  }

  /** 打开客户详情时将该客户全部未读询价标为已读 */
  async markReadByCustomer(user: AuthContext, customerId: string) {
    this.assertStaff(user);
    if (!customerId) throw new BadRequestException('customerId 必填');
    const now = new Date();
    if (this.db) {
      const result = await this.db
        .getRepository(Inquiry)
        .createQueryBuilder()
        .update(Inquiry)
        .set({ staffReadAt: now })
        .where('tenant_id = :tenantId AND customer_id = :customerId AND staff_read_at IS NULL', {
          tenantId: user.tenantId,
          customerId,
        })
        .execute();
      return { ok: true, affected: result.affected || 0 };
    }
    let affected = 0;
    for (const i of this.listStore) {
      if (i.tenantId === user.tenantId && i.customerId === customerId && i.staffReadAt == null) {
        i.staffReadAt = now;
        i.unread = false;
        affected += 1;
      }
    }
    return { ok: true, affected };
  }

  /** 员工将单条询价标为已处理，可附处理说明 */
  async markHandled(
    user: AuthContext,
    id: string,
    body?: { handledNote?: string; handleResult?: string },
  ) {
    this.assertStaff(user);
    const note = String(body?.handledNote ?? body?.handleResult ?? '')
      .trim()
      .slice(0, 512);
    const now = new Date();
    if (this.db) {
      const repo = this.db.getRepository(Inquiry);
      const e = await repo.findOne({ where: { id, tenantId: user.tenantId } });
      if (!e) throw new NotFoundException('询价不存在');
      e.status = 'handled';
      e.handledNote = note || e.handledNote || null;
      if (e.staffReadAt == null) e.staffReadAt = now;
      const saved = await repo.save(e);
      let productName: string | null = null;
      const p = await this.db.getRepository(Product).findOne({
        where: { id: saved.productId, tenantId: user.tenantId },
        select: ['id', 'name'],
      });
      productName = p?.name ?? null;
      return this.toRec(saved, productName);
    }
    const rec = this.listStore.find((i) => i.id === id && i.tenantId === user.tenantId);
    if (!rec) throw new NotFoundException('询价不存在');
    rec.status = 'handled';
    rec.handledNote = note || rec.handledNote || null;
    if (rec.staffReadAt == null) {
      rec.staffReadAt = now;
      rec.unread = false;
    }
    return { ...rec };
  }
}
