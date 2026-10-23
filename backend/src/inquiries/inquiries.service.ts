import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Inquiry } from '../common/entities/inquiry.entity';
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

/** 询价：关联单商品；可附带联系方式并回写客户档案 */
@Injectable()
export class InquiriesService {
  private readonly listStore: InquiryRec[] = [];
  private seq = 1;

  constructor(
    private readonly customers: CustomersService,
    @Optional() private readonly ds?: DataSource,
  ) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private toRec(e: Inquiry): InquiryRec {
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
      return rows.map((r) => this.toRec(r));
    }
    return this.listStore.filter((i) => {
      if (i.tenantId !== user.tenantId) return false;
      if (customerId && i.customerId !== customerId) return false;
      if (productId && i.productId !== productId) return false;
      return true;
    });
  }

  async get(user: AuthContext, id: string) {
    let rec: InquiryRec | null = null;
    if (this.db) {
      const e = await this.db.getRepository(Inquiry).findOne({ where: { id, tenantId: user.tenantId } });
      rec = e ? this.toRec(e) : null;
    } else {
      rec = this.listStore.find((i) => i.id === id && i.tenantId === user.tenantId) || null;
    }
    if (!rec || (user.role === 'customer' && rec.customerId !== user.customerId)) {
      throw new NotFoundException('询价不存在');
    }
    return rec;
  }
}
