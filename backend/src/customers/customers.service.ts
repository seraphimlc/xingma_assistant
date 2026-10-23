import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { newId } from '../common/utils/id';
import { LevelsService } from '../levels/levels.service';
import { CustomerRec } from './customer.types';
import { CUSTOMERS_REPO, ICustomersRepository } from './repositories/customers.repository';
import { InquiriesService } from '../inquiries/inquiries.service';

/** 客户服务：首次访问自动建档 + 默认等级 + 跟进/例外规则 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(CUSTOMERS_REPO) private readonly repo: ICustomersRepository,
    private readonly levels: LevelsService,
    @Optional()
    @Inject(forwardRef(() => InquiriesService))
    private readonly inquiries?: InquiriesService,
  ) {}

  async ensureProfile(user: AuthContext): Promise<CustomerRec> {
    let c = await this.repo.findByOpenid(user.tenantId, user.openid);
    if (c) return c;
    const def = await this.levels.getDefaultCustomerLevel(user.tenantId);
    const levelId = def?.id || 'cl_default';
    const levelCode = def?.code || 'L1';
    const rank = def?.rank ?? 1;
    const id = user.customerId || newId('cust');
    c = await this.repo.create({
      id,
      tenantId: user.tenantId,
      openid: user.openid,
      unionId: null,
      nickname: null,
      avatarUrl: null,
      levelId,
      levelCode,
      rank,
      phone: null,
      remark: null,
      firstShareEventId: null,
    });
    return c;
  }

  /** 首访绑定：记录首次分享（保持原签名，由调用方保证租户一致） */
  async markFirstShare(customerId: string, shareId: string, tenantId?: string) {
    const tid = tenantId || 'tenant_dev_001';
    const c = await this.repo.findById(tid, customerId);
    if (c && !c.firstShareEventId) {
      await this.repo.update(tid, customerId, { firstShareEventId: shareId });
    }
  }

  async list(tenantId: string, opts?: { levelId?: string; q?: string }, authUser?: AuthContext) {
    const rows = await this.repo.list(tenantId, opts);
    if (!this.inquiries || !authUser || (authUser.role !== 'owner' && authUser.role !== 'staff')) {
      return rows;
    }
    try {
      const summary = await this.inquiries.unreadSummary(authUser);
      const byId = new Map(summary.customers.map((c) => [c.customerId, c]));
      return rows.map((c) => {
        const st = byId.get(c.id);
        const { openid: _oid, ...rest } = c;
        return {
          ...rest,
          inquiryCount: st?.inquiryCount ?? 0,
          unreadInquiryCount: st?.unreadCount ?? 0,
          hasUnreadInquiry: st?.hasUnreadInquiry ?? false,
        };
      });
    } catch {
      return rows.map((c) => {
        const { openid: _oid, ...rest } = c;
        return rest;
      });
    }
  }

  /** 客户本人更新昵称/头像/手机 */
  async updateSelfProfile(
    user: AuthContext,
    patch: { nickname?: string | null; avatarUrl?: string | null; phone?: string | null },
  ) {
    const c = await this.ensureProfile(user);
    const updated = await this.repo.update(user.tenantId, c.id, patch);
    if (!updated) throw new NotFoundException('客户不存在');
    return updated;
  }

  async get(tenantId: string, id: string) {
    const c = await this.repo.findById(tenantId, id);
    if (!c) throw new NotFoundException('客户不存在');
    const followUps = await this.repo.listFollowUps(tenantId, id);
    const rules = await this.repo.listRules(tenantId, id);
    // 详情对员工不返回 openid（按产品要求）
    const { openid: _openid, ...rest } = c;
    return { ...rest, followUps, rules };
  }

  /** 人工调整等级：以租户配置为准，不信任客户端传来的 rank/code */
  async updateLevel(tenantId: string, customerId: string, levelId: string) {
    const level = await this.levels.getCustomerLevel(tenantId, levelId);
    const updated = await this.repo.update(tenantId, customerId, {
      levelId: level.id,
      levelCode: level.code,
      rank: level.rank,
    });
    if (!updated) throw new NotFoundException('客户不存在');
    return updated;
  }

  async batchUpdateLevel(tenantId: string, ids: string[], levelId: string) {
    if (!ids?.length) throw new BadRequestException('ids 不能为空');
    const level = await this.levels.getCustomerLevel(tenantId, levelId);
    const n = await this.repo.batchUpdateLevel(tenantId, ids, {
      levelId: level.id,
      levelCode: level.code,
      rank: level.rank,
    });
    return { ok: true, affected: n };
  }

  async addFollowUp(
    user: AuthContext,
    customerId: string,
    body: { content: string; kind?: string; inquiryId?: string },
  ) {
    if (!body.content?.trim()) throw new BadRequestException('内容不能为空');
    const c = await this.repo.findById(user.tenantId, customerId);
    if (!c) throw new NotFoundException('客户不存在');
    return this.repo.addFollowUp(user.tenantId, {
      customerId,
      authorMemberId: user.memberId || 'unknown',
      content: body.content.trim(),
      kind: body.kind || 'note',
      inquiryId: body.inquiryId ?? null,
    });
  }

  async removeFollowUp(tenantId: string, customerId: string, followUpId: string) {
    const list = await this.repo.listFollowUps(tenantId, customerId);
    if (!list.some((f) => f.id === followUpId)) throw new NotFoundException('跟进记录不存在');
    await this.repo.removeFollowUp(tenantId, followUpId);
    return { ok: true };
  }

  listRules(tenantId: string, customerId?: string, productId?: string) {
    return this.repo.listRules(tenantId, customerId, productId);
  }

  async upsertRule(
    tenantId: string,
    body: { customerId: string; productId: string; effect: 'allow' | 'deny'; remark?: string },
  ) {
    if (!body.customerId || !body.productId) throw new BadRequestException('客户与商品必填');
    if (body.effect !== 'allow' && body.effect !== 'deny') {
      throw new BadRequestException('effect 须为 allow|deny');
    }
    const c = await this.repo.findById(tenantId, body.customerId);
    if (!c) throw new NotFoundException('客户不存在');
    return this.repo.upsertRule(tenantId, body);
  }

  async removeRule(tenantId: string, id: string) {
    const ok = await this.repo.removeRule(tenantId, id);
    if (!ok) throw new NotFoundException('规则不存在');
    return { ok: true };
  }

  findRule(tenantId: string, customerId: string, productId: string) {
    return this.repo.findRule(tenantId, customerId, productId);
  }
}
