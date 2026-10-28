import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductGroup } from '../common/entities/product-group.entity';
import { Product } from '../common/entities/product.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { AuditService } from '../common/audit.service';
import { newId } from '../common/utils/id';

@Injectable()
export class ProductGroupsService {
  constructor(    private readonly audit: AuditService,
@Optional() private readonly dataSource?: DataSource,
  ) {}

  private assertStaff(user: AuthContext) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new BadRequestException('仅员工可操作分组');
    }
  }

  private repo() {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('分组需要启用数据库');
    }
    return this.dataSource.getRepository(ProductGroup);
  }

  private memFallback(tenantId: string) {
    return [
      {
        id: 'pg_current',
        tenantId,
        code: 'current',
        name: '本季款式',
        isLatest: true,
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'pg_offseason',
        tenantId,
        code: 'offseason',
        name: '过季款式',
        isLatest: false,
        sortOrder: 10,
        status: 'active',
      },
    ];
  }

  private toDto(r: ProductGroup) {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      isLatest: !!r.isLatest,
      sortOrder: r.sortOrder,
      status: r.status,
    };
  }

  private normalizeCode(raw?: string) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
  }

  async list(user: AuthContext) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { items: this.memFallback(user.tenantId) };
    }
    await this.ensureDefaults(user.tenantId);
    const rows = await this.repo().find({
      where: { tenantId: user.tenantId, status: 'active' },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return { items: rows.map((r) => this.toDto(r)) };
  }

  /** 确保租户有默认「本季」「过季」 */
  async ensureDefaults(tenantId: string) {
    const repo = this.repo();
    const count = await repo.count({ where: { tenantId } });
    if (count > 0) return;
    await repo.save([
      repo.create({
        id: newId('pg'),
        tenantId,
        code: 'current',
        name: '本季款式',
        isLatest: true,
        sortOrder: 0,
        status: 'active',
      }),
      repo.create({
        id: newId('pg'),
        tenantId,
        code: 'offseason',
        name: '过季款式',
        isLatest: false,
        sortOrder: 10,
        status: 'active',
      }),
    ]);
  }

  async getLatestGroupId(tenantId: string): Promise<string | null> {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return 'pg_current';
    }
    await this.ensureDefaults(tenantId);
    const latest = await this.repo().findOne({
      where: { tenantId, isLatest: true, status: 'active' },
    });
    if (latest) return latest.id;
    const any = await this.repo().findOne({
      where: { tenantId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
    return any?.id || null;
  }

  private async nextSortOrder(tenantId: string) {
    const last = await this.repo().findOne({
      where: { tenantId },
      order: { sortOrder: 'DESC' },
    });
    return (last?.sortOrder ?? -10) + 10;
  }

  async create(
    user: AuthContext,
    body: { name: string; code?: string; isLatest?: boolean },
  ) {
    this.assertStaff(user);
    const name = String(body.name || '').trim();
    if (!name) throw new BadRequestException('分组名称必填');
    const code =
      this.normalizeCode(body.code) || `g_${Date.now().toString(36)}`;
    await this.ensureDefaults(user.tenantId);
    const repo = this.repo();
    const clash = await repo.findOne({
      where: { tenantId: user.tenantId, code },
    });
    if (clash) throw new ConflictException('分组编码已存在');
    if (body.isLatest) {
      await repo.update(
        { tenantId: user.tenantId, isLatest: true },
        { isLatest: false },
      );
    }
    const sortOrder = await this.nextSortOrder(user.tenantId);
    const row = await repo.save(
      repo.create({
        id: newId('pg'),
        tenantId: user.tenantId,
        code,
        name,
        isLatest: !!body.isLatest,
        sortOrder,
        status: 'active',
      }),
    );
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product_group.create',
      targetType: 'product_group',
      targetId: row.id,
      detail: { name: row.name, code: row.code, isLatest: !!row.isLatest },
    });
    return this.toDto(row);
  }

  async update(
    user: AuthContext,
    groupId: string,
    body: { name?: string; code?: string },
  ) {
    this.assertStaff(user);
    const repo = this.repo();
    const g = await repo.findOne({
      where: { id: groupId, tenantId: user.tenantId, status: 'active' },
    });
    if (!g) throw new NotFoundException('分组不存在');

    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) throw new BadRequestException('分组名称必填');
      g.name = name;
    }

    if (body.code !== undefined) {
      const code = this.normalizeCode(body.code);
      if (!code) throw new BadRequestException('分组编码无效');
      if (code !== g.code) {
        const clash = await repo.findOne({
          where: { tenantId: user.tenantId, code },
        });
        if (clash && clash.id !== g.id) {
          throw new ConflictException('分组编码已存在');
        }
        g.code = code;
      }
    }

    await repo.save(g);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product_group.update',
      targetType: 'product_group',
      targetId: groupId,
      detail: { fields: Object.keys(body || {}) },
    });
    return this.toDto(g);
  }

  async setLatest(user: AuthContext, groupId: string) {
    this.assertStaff(user);
    const repo = this.repo();
    const g = await repo.findOne({
      where: { id: groupId, tenantId: user.tenantId, status: 'active' },
    });
    if (!g) throw new NotFoundException('分组不存在');
    await repo.update(
      { tenantId: user.tenantId, isLatest: true },
      { isLatest: false },
    );
    g.isLatest = true;
    await repo.save(g);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product_group.set_latest',
      targetType: 'product_group',
      targetId: groupId,
      detail: {},
    });
    return { id: g.id, isLatest: true };
  }

  async remove(user: AuthContext, groupId: string) {
    this.assertStaff(user);
    const repo = this.repo();
    const g = await repo.findOne({
      where: { id: groupId, tenantId: user.tenantId, status: 'active' },
    });
    if (!g) throw new NotFoundException('分组不存在');

    const activeCount = await repo.count({
      where: { tenantId: user.tenantId, status: 'active' },
    });
    if (activeCount <= 1) {
      throw new BadRequestException('至少保留一个分组');
    }

    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('需要数据库');
    }
    const prodRepo = this.dataSource!.getRepository(Product);
    const productCount = await prodRepo.count({
      where: { tenantId: user.tenantId, groupId },
    });
    if (productCount > 0) {
      throw new BadRequestException('请先把商品调到其它分组');
    }

    const wasLatest = !!g.isLatest;
    g.status = 'archived';
    g.isLatest = false;
    await repo.save(g);

    if (wasLatest) {
      const next = await repo.findOne({
        where: { tenantId: user.tenantId, status: 'active' },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      if (next) {
        next.isLatest = true;
        await repo.save(next);
      }
    }

    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product_group.archive',
      targetType: 'product_group',
      targetId: groupId,
      detail: { wasLatest },
    });
    return { id: g.id, status: 'archived' };
  }

  async moveProduct(user: AuthContext, productId: string, groupId: string) {
    this.assertStaff(user);
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('需要数据库');
    }
    const g = await this.repo().findOne({
      where: { id: groupId, tenantId: user.tenantId, status: 'active' },
    });
    if (!g) throw new NotFoundException('分组不存在');
    const prodRepo = this.dataSource!.getRepository(Product);
    const p = await prodRepo.findOne({
      where: { id: productId, tenantId: user.tenantId },
    });
    if (!p) throw new NotFoundException('商品不存在');
    p.groupId = groupId;
    await prodRepo.save(p);
    this.audit.enqueue({
      tenantId: user.tenantId,
      actor: user,
      action: 'product_group.move_product',
      targetType: 'product',
      targetId: productId,
      detail: { groupId, groupName: g.name },
    });
    return { productId, groupId, groupName: g.name };
  }
}
