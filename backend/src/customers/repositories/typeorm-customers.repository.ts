import { Injectable, Optional } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { CustomerProfile } from '../../common/entities/customer-profile.entity';
import { CustomerLevel } from '../../common/entities/customer-level.entity';
import { FollowUp } from '../../common/entities/follow-up.entity';
import { CustomerProductRule } from '../../common/entities/customer-product-rule.entity';
import { CustomerProductRuleRec, CustomerRec, FollowUpRec } from '../customer.types';
import { ICustomersRepository } from './customers.repository';

@Injectable()
export class TypeOrmCustomersRepository implements ICustomersRepository {
  private readonly customers: Repository<CustomerProfile>;
  private readonly levels: Repository<CustomerLevel>;
  private readonly followUps: Repository<FollowUp>;
  private readonly rules: Repository<CustomerProductRule>;

  constructor(@Optional() dataSource?: DataSource) {
    if (!dataSource) throw new Error('TypeOrmCustomersRepository 需要 DataSource');
    this.customers = dataSource.getRepository(CustomerProfile);
    this.levels = dataSource.getRepository(CustomerLevel);
    this.followUps = dataSource.getRepository(FollowUp);
    this.rules = dataSource.getRepository(CustomerProductRule);
  }

  private async toRec(e: CustomerProfile): Promise<CustomerRec> {
    const level = await this.levels.findOne({ where: { id: e.levelId, tenantId: e.tenantId } });
    return {
      id: e.id,
      tenantId: e.tenantId,
      openid: e.openid,
      unionId: e.unionId,
      nickname: e.nickname,
      avatarUrl: e.avatarUrl,
      levelId: e.levelId,
      levelCode: level?.code || '',
      rank: level?.rank ?? 0,
      phone: e.phone,
      remark: e.remark,
      firstShareEventId: e.firstShareEventId,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  async list(
    tenantId: string,
    opts?: { levelId?: string; q?: string; page?: number; pageSize?: number; ids?: string[] },
  ) {
    const qb = this.customers.createQueryBuilder('c').where('c.tenant_id = :tenantId', { tenantId });
    // 列表：头像或昵称任一即可；两者皆无则不展示（不强制手机、不去重）
    qb.andWhere(
      "((c.avatar_url IS NOT NULL AND TRIM(c.avatar_url) <> '') OR (c.nickname IS NOT NULL AND TRIM(c.nickname) <> ''))",
    );
    if (opts?.levelId) qb.andWhere('c.level_id = :levelId', { levelId: opts.levelId });
    if (opts?.q) {
      qb.andWhere('(c.nickname LIKE :q OR c.openid LIKE :q OR c.phone LIKE :q)', {
        q: `%${opts.q}%`,
      });
    }
    if (opts?.ids) {
      if (!opts.ids.length) return { items: [], total: 0 };
      qb.andWhere('c.id IN (:...ids)', { ids: opts.ids });
    }
    qb.orderBy('c.created_at', 'DESC');
    const page = Math.max(1, Number(opts?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(opts?.pageSize) || 20));
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    if (!rows.length) return { items: [], total };
    // Batch levels once — avoid N+1 findOne per customer
    const levelIds = [...new Set(rows.map((r) => r.levelId).filter(Boolean))];
    const levels = levelIds.length
      ? await this.levels.find({ where: { tenantId, id: In(levelIds) } })
      : [];
    const levelMap = new Map(levels.map((l) => [l.id, l]));
    const items = rows.map((e) => {
      const level = levelMap.get(e.levelId);
      return {
        id: e.id,
        tenantId: e.tenantId,
        openid: e.openid,
        unionId: e.unionId,
        nickname: e.nickname,
        avatarUrl: e.avatarUrl,
        levelId: e.levelId,
        levelCode: level?.code || '',
        rank: level?.rank ?? 0,
        phone: e.phone,
        remark: e.remark,
        firstShareEventId: e.firstShareEventId,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
    });
    return { items, total };
  }

  async findById(tenantId: string, id: string) {
    const e = await this.customers.findOne({ where: { id, tenantId } });
    return e ? this.toRec(e) : null;
  }

  async findByOpenid(tenantId: string, openid: string) {
    const e = await this.customers.findOne({ where: { tenantId, openid } });
    return e ? this.toRec(e) : null;
  }

  async create(rec: Omit<CustomerRec, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date }) {
    const saved = await this.customers.save(
      this.customers.create({
        id: rec.id,
        tenantId: rec.tenantId,
        openid: rec.openid,
        unionId: rec.unionId,
        nickname: rec.nickname,
        avatarUrl: rec.avatarUrl,
        levelId: rec.levelId,
        phone: rec.phone,
        remark: rec.remark,
        firstShareEventId: rec.firstShareEventId,
      }),
    );
    return this.toRec(saved);
  }

  async update(tenantId: string, id: string, patch: Partial<CustomerRec>) {
    const e = await this.customers.findOne({ where: { id, tenantId } });
    if (!e) return null;
    if ('nickname' in patch) e.nickname = patch.nickname ?? null;
    if ('avatarUrl' in patch) e.avatarUrl = patch.avatarUrl ?? null;
    if ('levelId' in patch && patch.levelId) e.levelId = patch.levelId;
    if ('phone' in patch) e.phone = patch.phone ?? null;
    if ('remark' in patch) e.remark = patch.remark ?? null;
    if ('firstShareEventId' in patch) e.firstShareEventId = patch.firstShareEventId ?? null;
    const saved = await this.customers.save(e);
    return this.toRec(saved);
  }

  async batchUpdateLevel(
    tenantId: string,
    ids: string[],
    level: { levelId: string; levelCode: string; rank: number },
  ) {
    if (!ids.length) return 0;
    const result = await this.customers
      .createQueryBuilder()
      .update(CustomerProfile)
      .set({ levelId: level.levelId })
      .where('tenant_id = :tenantId AND id IN (:...ids)', { tenantId, ids })
      .execute();
    return result.affected || 0;
  }

  async listFollowUps(tenantId: string, customerId: string) {
    const rows = await this.followUps.find({
      where: { tenantId, customerId, status: 'active' as any },
      order: { createdAt: 'DESC' },
    });
    return rows.map(
      (f): FollowUpRec => ({
        id: f.id,
        tenantId: f.tenantId,
        inquiryId: f.inquiryId,
        customerId: f.customerId,
        authorMemberId: f.authorMemberId,
        content: f.content,
        kind: f.kind,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      }),
    );
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
    const saved = await this.followUps.save(
      this.followUps.create({
        tenantId,
        customerId: input.customerId,
        authorMemberId: input.authorMemberId,
        content: input.content,
        kind: input.kind || 'note',
        inquiryId: input.inquiryId ?? null,
      }),
    );
    return {
      id: saved.id,
      tenantId: saved.tenantId,
      inquiryId: saved.inquiryId,
      customerId: saved.customerId,
      authorMemberId: saved.authorMemberId,
      content: saved.content,
      kind: saved.kind,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async removeFollowUp(tenantId: string, id: string) {
    const row = await this.followUps.findOne({ where: { id, tenantId } });
    if (!row) return false;
    (row as any).status = 'deleted';
    await this.followUps.save(row);
    return true;
  }

  async listRules(tenantId: string, customerId?: string, productId?: string) {
    const where: Record<string, string> = { tenantId };
    if (customerId) where.customerId = customerId;
    if (productId) where.productId = productId;
    const rows = await this.rules.find({ where });
    return rows.filter((r) => (r as any).status !== 'deleted').map(
      (r): CustomerProductRuleRec => ({
        id: r.id,
        tenantId: r.tenantId,
        customerId: r.customerId,
        productId: r.productId,
        effect: r.effect as 'allow' | 'deny',
        remark: r.remark,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );
  }

  async findRule(tenantId: string, customerId: string, productId: string) {
    const r = await this.rules.findOne({ where: { tenantId, customerId, productId } });
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenantId,
      customerId: r.customerId,
      productId: r.productId,
      effect: r.effect as 'allow' | 'deny',
      remark: r.remark,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async upsertRule(
    tenantId: string,
    input: { customerId: string; productId: string; effect: 'allow' | 'deny'; remark?: string | null },
  ) {
    let r = await this.rules.findOne({
      where: { tenantId, customerId: input.customerId, productId: input.productId },
    });
    if (r) {
      r.effect = input.effect;
      r.remark = input.remark ?? null;
    } else {
      r = this.rules.create({
        tenantId,
        customerId: input.customerId,
        productId: input.productId,
        effect: input.effect,
        remark: input.remark ?? null,
      });
    }
    const saved = await this.rules.save(r);
    return {
      id: saved.id,
      tenantId: saved.tenantId,
      customerId: saved.customerId,
      productId: saved.productId,
      effect: saved.effect as 'allow' | 'deny',
      remark: saved.remark,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async removeRule(tenantId: string, id: string) {
    const row = await this.rules.findOne({ where: { id, tenantId } });
    if (!row) return false;
    (row as any).status = 'deleted';
    await this.rules.save(row);
    return true;
  }
}
