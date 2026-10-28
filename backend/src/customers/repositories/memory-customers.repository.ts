import { Injectable } from '@nestjs/common';
import { newId } from '../../common/utils/id';
import { CustomerProductRuleRec, CustomerRec, FollowUpRec } from '../customer.types';
import { ICustomersRepository } from './customers.repository';

@Injectable()
export class MemoryCustomersRepository implements ICustomersRepository {
  private readonly byId = new Map<string, CustomerRec>();
  private readonly byOpenid = new Map<string, string>(); // tenant:openid -> id
  private readonly followUps = new Map<string, FollowUpRec>();
  private readonly rules = new Map<string, CustomerProductRuleRec>();

  async list(
    tenantId: string,
    opts?: { levelId?: string; q?: string; page?: number; pageSize?: number; ids?: string[] },
  ) {
    let items = [...this.byId.values()].filter((c) => c.tenantId === tenantId);
    // 列表：头像或昵称任一即可；两者皆无则不展示（不强制手机、不去重）
    items = items.filter(
      (c) => !!(String(c.avatarUrl || '').trim() || String(c.nickname || '').trim()),
    );
    if (opts?.levelId) items = items.filter((c) => c.levelId === opts.levelId);
    if (opts?.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (c) =>
          (c.nickname || '').toLowerCase().includes(q) ||
          c.openid.toLowerCase().includes(q) ||
          (c.phone || '').includes(q),
      );
    }
    if (opts?.ids) {
      const allow = new Set(opts.ids);
      items = items.filter((c) => allow.has(c.id));
    }
    items.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const total = items.length;
    const page = Math.max(1, Number(opts?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts?.pageSize) || 20));
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize).map((c) => ({ ...c })), total };
  }

  async findById(tenantId: string, id: string) {
    const c = this.byId.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async findByOpenid(tenantId: string, openid: string) {
    const id = this.byOpenid.get(`${tenantId}:${openid}`);
    if (!id) return null;
    return this.findById(tenantId, id);
  }

  async create(rec: Omit<CustomerRec, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date }) {
    const now = new Date();
    const full: CustomerRec = {
      ...rec,
      createdAt: rec.createdAt || now,
      updatedAt: rec.updatedAt || now,
    };
    this.byId.set(full.id, full);
    this.byOpenid.set(`${full.tenantId}:${full.openid}`, full.id);
    return { ...full };
  }

  async update(tenantId: string, id: string, patch: Partial<CustomerRec>) {
    const c = this.byId.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    Object.assign(c, patch, { updatedAt: new Date() });
    this.byId.set(id, c);
    return { ...c };
  }

  async batchUpdateLevel(
    tenantId: string,
    ids: string[],
    level: { levelId: string; levelCode: string; rank: number },
  ) {
    let n = 0;
    for (const id of ids) {
      const c = this.byId.get(id);
      if (c && c.tenantId === tenantId) {
        c.levelId = level.levelId;
        c.levelCode = level.levelCode;
        c.rank = level.rank;
        c.updatedAt = new Date();
        n++;
      }
    }
    return n;
  }

  async listFollowUps(tenantId: string, customerId: string) {
    return [...this.followUps.values()]
      .filter((f) => f.tenantId === tenantId && f.customerId === customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((f) => ({ ...f }));
  }

  async addFollowUp(
    tenantId: string,
    input: {
      customerId: string;
      authorMemberId: string;
      content: string;
      kind?: string;
      inquiryId?: string | null;
    },
  ) {
    const now = new Date();
    const rec: FollowUpRec = {
      id: newId('fu'),
      tenantId,
      inquiryId: input.inquiryId ?? null,
      customerId: input.customerId,
      authorMemberId: input.authorMemberId,
      content: input.content,
      kind: input.kind || 'note',
      createdAt: now,
      updatedAt: now,
    };
    this.followUps.set(rec.id, rec);
    return { ...rec };
  }

  async removeFollowUp(tenantId: string, id: string) {
    const f = this.followUps.get(id);
    if (!f || f.tenantId !== tenantId) return false;
    (f as any).status = 'deleted';
    return true;
  }

  async listRules(tenantId: string, customerId?: string, productId?: string) {
    return [...this.rules.values()]
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        if (customerId && r.customerId !== customerId) return false;
        if (productId && r.productId !== productId) return false;
        return true;
      })
      .map((r) => ({ ...r }));
  }

  async findRule(tenantId: string, customerId: string, productId: string) {
    for (const r of this.rules.values()) {
      if (r.tenantId === tenantId && r.customerId === customerId && r.productId === productId) {
        return { ...r };
      }
    }
    return null;
  }

  async upsertRule(
    tenantId: string,
    input: { customerId: string; productId: string; effect: 'allow' | 'deny'; remark?: string | null },
  ) {
    const existing = await this.findRule(tenantId, input.customerId, input.productId);
    if (existing) {
      const cur = this.rules.get(existing.id)!;
      cur.effect = input.effect;
      cur.remark = input.remark ?? null;
      cur.updatedAt = new Date();
      return { ...cur };
    }
    const now = new Date();
    const rec: CustomerProductRuleRec = {
      id: newId('cpr'),
      tenantId,
      customerId: input.customerId,
      productId: input.productId,
      effect: input.effect,
      remark: input.remark ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(rec.id, rec);
    return { ...rec };
  }

  async removeRule(tenantId: string, id: string) {
    const r = this.rules.get(id);
    if (!r || r.tenantId !== tenantId) return false;
    (r as any).status = 'deleted';
    return true;
  }
}
