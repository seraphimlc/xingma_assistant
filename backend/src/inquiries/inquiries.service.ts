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
import { TenantMember } from '../common/entities/tenant-member.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { AuditService } from '../common/audit.service';
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
  assigneeMemberId: string | null;
  assigneeOpenid: string | null;
  assigneeName: string | null;
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
  /** open|pending|in_progress only — list badge must ignore handled */
  pendingInquiryCount: number;
  unreadCount: number;
  hasUnreadInquiry: boolean;
  hasPendingInquiry: boolean;
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
    private readonly audit: AuditService,
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
      assigneeMemberId: e.assigneeMemberId ?? null,
      assigneeOpenid: e.assigneeOpenid ?? null,
      assigneeName: e.assigneeName ?? null,
      staffReadAt,
      handledNote: e.handledNote ?? null,
      unread: staffReadAt == null,
      productName: productName ?? null,
      createdAt: e.createdAt,
    };
  }

  private async resolveHandler(user: AuthContext): Promise<{
    memberId: string | null;
    openid: string;
    name: string;
  }> {
    const openid = user.openid;
    let name = '';
    if (this.db) {
      const m = await this.db.getRepository(TenantMember).findOne({
        where: { tenantId: user.tenantId, openid },
      });
      if (m?.nickname) name = String(m.nickname).trim();
    }
    if (!name) name = openid ? `员工${openid.slice(-4)}` : '员工';
    return {
      memberId: user.memberId || null,
      openid,
      name: name.slice(0, 64),
    };
  }

  private applyHandler(
    target: { assigneeMemberId: string | null; assigneeOpenid?: string | null; assigneeName?: string | null },
    handler: { memberId: string | null; openid: string; name: string },
  ) {
    target.assigneeMemberId = handler.memberId;
    target.assigneeOpenid = handler.openid;
    target.assigneeName = handler.name;
  }

  async create(user: AuthContext, body: CreateInquiryBody) {
    if (!body.productId) throw new BadRequestException('商品必填');
    // 员工/业主自测分享落地也会建 customer_profiles；JWT 可能仍无 customerId，
    // 对任意已登录用户 ensureProfile 后以其客户档 id 写询价（owner/staff/customer 均可）。
    const profile = await this.customers.ensureProfile(user);
    const customerId = profile.id;

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

    // 回写客户档案（有填才写）；ensureProfile 已保证档案存在，staff 亦可写 phone/nickname
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
          customerId,
          content,
          phone: phone || null,
          contactName: contactName || null,
          remark: remark || null,
          status: 'open',
          assigneeMemberId: null,
          assigneeOpenid: null,
          assigneeName: null,
          staffReadAt: null,
          handledNote: null,
        }),
      );
      this.audit.enqueue({
        tenantId: user.tenantId,
        actor: user,
        action: 'inquiry.create',
        targetType: 'inquiry',
        targetId: saved.id,
        detail: { productId: body.productId, customerId, hasPhone: !!phone },
      });
      return this.toRec(saved);
    }
    const rec: InquiryRec = {
      id: `inq_${String(this.seq++).padStart(6, '0')}`,
      tenantId: user.tenantId,
      productId: body.productId,
      customerId,
      content,
      phone: phone || null,
      contactName: contactName || null,
      remark: remark || null,
      status: 'open',
      assigneeMemberId: null,
      assigneeOpenid: null,
      assigneeName: null,
      staffReadAt: null,
      handledNote: null,
      unread: true,
      productName: null,
      createdAt: new Date(),
    };
    this.listStore.push(rec);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'inquiry.create',
      targetType: 'inquiry',
      targetId: rec.id,
      detail: { productId: body.productId, customerId, hasPhone: !!phone },
    });
    return rec;
  }

  async list(
    user: AuthContext,
    opts?: {
      productId?: string;
      customerId?: string;
      status?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const onlyMine = user.role === 'customer';
    const productId = opts?.productId ? String(opts.productId) : '';
    let customerId = opts?.customerId ? String(opts.customerId) : '';
    const status = String(opts?.status || '').trim();
    const page = Math.max(1, Number(opts?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts?.pageSize) || 20));
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
      if (status) qb.andWhere('i.status = :status', { status });
      const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
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
      return {
        items: rows.map((r) => this.toRec(r, nameMap.get(r.productId) ?? null)),
        total,
        page,
        pageSize,
      };
    }
    const filtered = this.listStore
      .filter((i) => {
        if (i.tenantId !== user.tenantId) return false;
        if (customerId && i.customerId !== customerId) return false;
        if (productId && i.productId !== productId) return false;
        if (status && i.status !== status) return false;
        return true;
      })
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize).map((i) => ({ ...i, unread: i.staffReadAt == null })),
      total,
      page,
      pageSize,
    };
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

  /** 红点摘要：未处理(open/pending)或未读；已处理/关闭不计（列表行+Tab） */
  async unreadSummary(user: AuthContext): Promise<UnreadSummary> {
    this.assertStaff(user);
    if (this.db) {
      const rows = await this.db
        .getRepository(Inquiry)
        .createQueryBuilder('i')
        .select('i.customer_id', 'customerId')
        .addSelect('COUNT(*)', 'inquiryCount')
        .addSelect(
          `SUM(CASE WHEN i.status IN ('open', 'pending', 'in_progress') THEN 1 ELSE 0 END)`,
          'pendingInquiryCount',
        )
        .addSelect(
          `SUM(CASE WHEN i.status NOT IN ('handled', 'closed', 'replied')
            AND (i.staff_read_at IS NULL OR i.status IN ('open', 'pending', 'in_progress'))
            THEN 1 ELSE 0 END)`,
          'unreadCount',
        )
        .where('i.tenant_id = :tenantId', { tenantId: user.tenantId })
        .groupBy('i.customer_id')
        .getRawMany<{ customerId: string; inquiryCount: string; pendingInquiryCount: string; unreadCount: string }>();
      const customers: CustomerInquiryStat[] = rows.map((r) => {
        const inquiryCount = Number(r.inquiryCount) || 0;
        const pendingInquiryCount = Number(r.pendingInquiryCount) || 0;
        const unreadCount = Number(r.unreadCount) || 0;
        return {
          customerId: r.customerId,
          inquiryCount,
          pendingInquiryCount,
          unreadCount,
          hasUnreadInquiry: unreadCount > 0,
          hasPendingInquiry: pendingInquiryCount > 0,
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
        pendingInquiryCount: 0,
        unreadCount: 0,
        hasUnreadInquiry: false,
        hasPendingInquiry: false,
      };
      cur.inquiryCount += 1;
      const st = String(i.status || 'open');
      const isOpen = st === 'open' || st === 'pending' || st === 'in_progress';
      const isDone = st === 'handled' || st === 'closed' || st === 'replied';
      if (isOpen) cur.pendingInquiryCount += 1;
      // 红点：待沟通/正在沟通 或 未读；已处理不再计入
      if (!isDone && (i.staffReadAt == null || isOpen)) cur.unreadCount += 1;
      cur.hasUnreadInquiry = cur.unreadCount > 0;
      cur.hasPendingInquiry = cur.pendingInquiryCount > 0;
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

  /** 待沟通 → 我来沟通：记处理人，状态变为正在沟通 */
  async claim(
    user: AuthContext,
    id: string,
  ) {
    this.assertStaff(user);
    const handler = await this.resolveHandler(user);
    const now = new Date();
    if (this.db) {
      const repo = this.db.getRepository(Inquiry);
      const e = await repo.findOne({ where: { id, tenantId: user.tenantId } });
      if (!e) throw new NotFoundException('询价不存在');
      if (e.status === 'handled' || e.status === 'closed' || e.status === 'replied') {
        throw new BadRequestException('该询价已处理完成');
      }
      // 已在沟通中：保留原处理人，不抢单；本人可再次点确认
      if (e.status === 'in_progress' && e.assigneeMemberId && e.assigneeMemberId !== handler.memberId) {
        throw new BadRequestException(`已由 ${e.assigneeName || '同事'} 沟通中`);
      }
      e.status = 'in_progress';
      this.applyHandler(e, handler);
      if (!e.staffReadAt) e.staffReadAt = now;
      const saved = await repo.save(e);
      this.audit.enqueue({
        tenantId: user.tenantId,
        actor: user,
        action: 'inquiry.claim',
        targetType: 'inquiry',
        targetId: saved.id,
        detail: { status: saved.status, assigneeMemberId: saved.assigneeMemberId },
      });
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
    if (rec.status === 'handled' || rec.status === 'closed' || rec.status === 'replied') {
      throw new BadRequestException('该询价已处理完成');
    }
    if (rec.status === 'in_progress' && rec.assigneeMemberId && rec.assigneeMemberId !== handler.memberId) {
      throw new BadRequestException(`已由 ${rec.assigneeName || '同事'} 沟通中`);
    }
    rec.status = 'in_progress';
    this.applyHandler(rec, handler);
    if (!rec.staffReadAt) rec.staffReadAt = now;
    rec.unread = false;
    return { ...rec };
  }

  /** 正在沟通 → 沟通完成：填写沟通内容，保留处理人 */
  async markHandled(
    user: AuthContext,
    id: string,
    body?: { handledNote?: string; handleResult?: string },
  ) {
    this.assertStaff(user);
    const note = String(body?.handledNote ?? body?.handleResult ?? '')
      .trim()
      .slice(0, 512);
    if (!note) throw new BadRequestException('请填写沟通内容');
    const handler = await this.resolveHandler(user);
    const now = new Date();
    if (this.db) {
      const repo = this.db.getRepository(Inquiry);
      const e = await repo.findOne({ where: { id, tenantId: user.tenantId } });
      if (!e) throw new NotFoundException('询价不存在');
      if (e.status === 'handled' || e.status === 'closed' || e.status === 'replied') {
        throw new BadRequestException('该询价已处理完成');
      }
      // 尚未认领或姓名缺失时记/补处理人（旧数据可能只有 status=handled）
      if (!e.assigneeMemberId && !e.assigneeOpenid) {
        this.applyHandler(e, handler);
      } else if (!(e.assigneeName || '').trim()) {
        e.assigneeName = handler.name;
        if (!e.assigneeOpenid) e.assigneeOpenid = handler.openid;
        if (!e.assigneeMemberId) e.assigneeMemberId = handler.memberId;
      }
      e.status = 'handled';
      e.handledNote = note;
      e.staffReadAt = now;
      const saved = await repo.save(e);
      this.audit.enqueue({
        tenantId: user.tenantId,
        actor: user,
        action: 'inquiry.handled',
        targetType: 'inquiry',
        targetId: saved.id,
        detail: { status: saved.status, hasNote: !!note },
      });
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
    if (rec.status === 'handled' || rec.status === 'closed' || rec.status === 'replied') {
      throw new BadRequestException('该询价已处理完成');
    }
    if (!rec.assigneeMemberId && !rec.assigneeOpenid) {
      this.applyHandler(rec, handler);
    } else if (!(rec.assigneeName || '').trim()) {
      rec.assigneeName = handler.name;
      if (!rec.assigneeOpenid) rec.assigneeOpenid = handler.openid;
      if (!rec.assigneeMemberId) rec.assigneeMemberId = handler.memberId;
    }
    rec.status = 'handled';
    rec.handledNote = note;
    rec.staffReadAt = now;
    rec.unread = false;
    return { ...rec };
  }
}
