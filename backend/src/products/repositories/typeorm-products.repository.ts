import { Injectable, Optional } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Product } from '../../common/entities/product.entity';
import { ProductSku } from '../../common/entities/product-sku.entity';
import {
  CreateProductInput,
  CreateSkuInput,
  PriceDisplay,
  ProductListQuery,
  ProductRec,
  ProductSkuRec,
  ProductStatus,
  UpdateProductInput,
} from '../product.types';
import { SharePolicy } from '../product-access.service';
import { IProductsRepository } from './products.repository';

/** TypeORM 实现：仅在 DB_ENABLED=true 且 DataSource 可用时注入 */
@Injectable()
export class TypeOrmProductsRepository implements IProductsRepository {
  private readonly products: Repository<Product>;
  private readonly skus: Repository<ProductSku>;

  constructor(@Optional() dataSource?: DataSource) {
    if (!dataSource) {
      throw new Error('TypeOrmProductsRepository 需要 DataSource（请设 DB_ENABLED=true）');
    }
    this.products = dataSource.getRepository(Product);
    this.skus = dataSource.getRepository(ProductSku);
  }

  private toRec(p: Product): ProductRec {
    return {
      id: p.id,
      tenantId: p.tenantId,
      styleNo: p.styleNo,
      name: p.name,
      description: p.description,
      material: p.material ?? null,
      levelId: p.levelId,
      groupId: p.groupId ?? null,
      priceDisplay: (p.priceDisplay as PriceDisplay) || 'show',
      sharePolicy: (p.sharePolicy as SharePolicy) || null,
      allowCustomerDownload: !!p.allowCustomerDownload,
      coverMediaIds: p.coverMediaIds,
      tags: p.tags ?? null,
      status: (p.status as ProductStatus) || 'on_sale',
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private toSku(s: ProductSku): ProductSkuRec {
    return {
      id: s.id,
      tenantId: s.tenantId,
      productId: s.productId,
      skuCode: s.skuCode,
      color: s.color,
      size: s.size,
      price: s.price,
      stock: s.stock,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async list(tenantId: string, query: ProductListQuery = {}) {
    const qb = this.products.createQueryBuilder('p').where('p.tenant_id = :tenantId', { tenantId });
    if (query.q) {
      qb.andWhere('p.style_no LIKE :q', { q: `%${query.q}%` });
    }
    if (query.levelId) qb.andWhere('p.level_id = :levelId', { levelId: query.levelId });
    if (query.status) qb.andWhere('p.status = :status', { status: query.status });
    if (query.groupId) qb.andWhere('p.group_id = :groupId', { groupId: query.groupId });
    if (query.tag) {
      qb.andWhere('JSON_CONTAINS(p.tags, :tagJson)', { tagJson: JSON.stringify(query.tag) });
    }
    qb.orderBy(
      "CASE WHEN p.status = 'on_sale' THEN 0 WHEN p.status = 'off_sale' THEN 1 ELSE 2 END",
      'ASC',
    ).addOrderBy('p.created_at', 'DESC');
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 50));
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items: rows.map((r) => this.toRec(r)), total };
  }

  async findById(tenantId: string, id: string) {
    const p = await this.products.findOne({ where: { id, tenantId } });
    return p ? this.toRec(p) : null;
  }

  async findByStyleNo(tenantId: string, styleNo: string) {
    const p = await this.products.findOne({ where: { tenantId, styleNo } });
    return p ? this.toRec(p) : null;
  }

  async create(tenantId: string, input: CreateProductInput) {
    const entity = this.products.create({
      tenantId,
      styleNo: input.styleNo.trim(),
      name: input.name.trim(),
      description: input.description ?? null,
      material: input.material ?? null,
      levelId: input.levelId,
      groupId: input.groupId ?? null,
      priceDisplay: input.priceDisplay || 'show',
      sharePolicy: input.sharePolicy ?? null,
      allowCustomerDownload: input.allowCustomerDownload ?? false,
      coverMediaIds: input.coverMediaIds ?? [],
      tags: input.tags ?? [],
      status: input.status || 'on_sale',
      sortOrder: input.sortOrder ?? 0,
    });
    const saved = await this.products.save(entity);
    for (const sku of input.skus || []) {
      await this.addSku(tenantId, saved.id, sku);
    }
    return this.toRec(saved);
  }

  async update(tenantId: string, id: string, input: UpdateProductInput) {
    const p = await this.products.findOne({ where: { id, tenantId } });
    if (!p) return null;
    if (input.styleNo !== undefined) p.styleNo = input.styleNo.trim();
    if (input.name !== undefined) p.name = input.name.trim();
    if ('description' in input) p.description = input.description ?? null;
    if ('material' in input) p.material = input.material ?? null;
    if (input.levelId) p.levelId = input.levelId;
    if ('groupId' in input) p.groupId = input.groupId ?? null;
    if (input.priceDisplay) p.priceDisplay = input.priceDisplay;
    if ('sharePolicy' in input) p.sharePolicy = input.sharePolicy ?? null;
    if ('allowCustomerDownload' in input && input.allowCustomerDownload !== undefined) {
      p.allowCustomerDownload = !!input.allowCustomerDownload;
    }
    if ('coverMediaIds' in input) p.coverMediaIds = input.coverMediaIds ?? null;
    if ('tags' in input) p.tags = input.tags ?? null;
    if (input.status) p.status = input.status;
    if (input.sortOrder !== undefined) p.sortOrder = input.sortOrder;
    const saved = await this.products.save(p);
    return this.toRec(saved);
  }

  async softOffSale(tenantId: string, id: string) {
    return this.update(tenantId, id, { status: 'off_sale' });
  }

  async batchSetStatus(tenantId: string, ids: string[], status: string) {
    if (!ids.length) return 0;
    const result = await this.products
      .createQueryBuilder()
      .update(Product)
      .set({ status })
      .where('tenant_id = :tenantId AND id IN (:...ids)', { tenantId, ids })
      .execute();
    return result.affected || 0;
  }

  async copy(tenantId: string, id: string, newStyleNo: string) {
    const src = await this.findById(tenantId, id);
    if (!src) return null;
    const skus = await this.listSkus(tenantId, id);
    return this.create(tenantId, {
      styleNo: newStyleNo,
      name: `${src.name}（副本）`,
      description: src.description,
      material: src.material,
      levelId: src.levelId,
      groupId: src.groupId,
      priceDisplay: src.priceDisplay,
      sharePolicy: src.sharePolicy,
      allowCustomerDownload: false,
      coverMediaIds: src.coverMediaIds ? [...src.coverMediaIds] : [],
      tags: src.tags ? [...src.tags] : [],
      status: 'off_sale',
      sortOrder: src.sortOrder,
      skus: skus.map((s) => ({
        skuCode: `${s.skuCode}-COPY`,
        color: s.color,
        size: s.size,
        price: s.price,
        stock: s.stock,
        status: s.status,
      })),
    });
  }

  async listSkus(tenantId: string, productId: string) {
    const rows = await this.skus.find({ where: { tenantId, productId } });
    return rows.filter((r) => r.status !== 'deleted').map((r) => this.toSku(r));
  }

  async listSkusByProductIds(tenantId: string, productIds: string[]) {
    const out = new Map<string, ProductSkuRec[]>();
    for (const id of productIds) out.set(id, []);
    const ids = [...new Set(productIds.filter(Boolean))];
    if (!ids.length) return out;
    const rows = await this.skus
      .createQueryBuilder('s')
      .where('s.tenant_id = :tenantId', { tenantId })
      .andWhere('s.product_id IN (:...ids)', { ids })
      .andWhere("s.status <> 'deleted'")
      .getMany();
    for (const r of rows) {
      const list = out.get(r.productId) || [];
      list.push(this.toSku(r));
      out.set(r.productId, list);
    }
    return out;
  }

  async findSku(tenantId: string, skuId: string) {
    const s = await this.skus.findOne({ where: { id: skuId, tenantId } });
    return s ? this.toSku(s) : null;
  }

  async addSku(tenantId: string, productId: string, input: CreateSkuInput) {
    const color = input.color ?? null;
    const size = input.size ?? null;
    const skuCode =
      input.skuCode?.trim() ||
      `${productId.slice(-6)}-${(color || 'NA').slice(0, 8)}-${(size || 'NA').slice(0, 8)}-${Date.now().toString(36)}`;
    const entity = this.skus.create({
      tenantId,
      productId,
      skuCode,
      color,
      size,
      price: input.price != null ? String(input.price) : null,
      stock: input.stock ?? 0,
      status: input.status || 'active',
    });
    const saved = await this.skus.save(entity);
    return this.toSku(saved);
  }

  async updateSku(tenantId: string, skuId: string, input: Partial<CreateSkuInput>) {
    const s = await this.skus.findOne({ where: { id: skuId, tenantId } });
    if (!s) return null;
    if (input.skuCode !== undefined) s.skuCode = input.skuCode.trim();
    if ('color' in input) s.color = input.color ?? null;
    if ('size' in input) s.size = input.size ?? null;
    if ('price' in input) s.price = input.price != null ? String(input.price) : null;
    if (input.stock !== undefined) s.stock = input.stock;
    if (input.status) s.status = input.status;
    const saved = await this.skus.save(s);
    return this.toSku(saved);
  }

  async removeSku(tenantId: string, skuId: string) {
    const s = await this.skus.findOne({ where: { id: skuId, tenantId } });
    if (!s) return false;
    // Soft-delete must free uk_sku (tenantId, productId, skuCode) so recreate/upsert can reuse codes.
    const base = String(s.skuCode || 'sku').slice(0, 40);
    s.skuCode = `${base}__del__${String(s.id).slice(0, 8)}`;
    s.status = 'deleted';
    await this.skus.save(s);
    return true;
  }

  /** Revive a soft-deleted SKU with the same product+skuCode, or null if none. */
  async reviveSkuByCode(
    tenantId: string,
    productId: string,
    skuCode: string,
    input: CreateSkuInput,
  ) {
    const rows = await this.skus.find({ where: { tenantId, productId } });
    const hit = rows.find((r) => r.status === 'deleted' && r.skuCode === skuCode)
      || rows.find(
          (r) =>
            r.status === 'deleted' &&
            (r.skuCode || '').startsWith(`${skuCode}__del__`),
        );
    if (!hit) return null;
    hit.skuCode = skuCode;
    hit.color = input.color ?? null;
    hit.size = input.size ?? null;
    hit.price = input.price != null ? String(input.price) : null;
    hit.stock = input.stock ?? 0;
    hit.status = input.status || 'active';
    const saved = await this.skus.save(hit);
    return this.toSku(saved);
  }
}
