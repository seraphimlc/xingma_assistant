import { Injectable } from '@nestjs/common';
import { newId } from '../../common/utils/id';
import {
  CreateProductInput,
  CreateSkuInput,
  ProductListQuery,
  ProductRec,
  ProductSkuRec,
  UpdateProductInput,
} from '../product.types';
import { IProductsRepository } from './products.repository';

@Injectable()
export class MemoryProductsRepository implements IProductsRepository {
  private readonly products = new Map<string, ProductRec>();
  private readonly skus = new Map<string, ProductSkuRec>();

  constructor() {
    const now = new Date();
    const demo: ProductRec = {
      id: 'prod_demo_001',
      tenantId: 'tenant_dev_001',
      styleNo: 'WS-2026-001',
      name: '秋冬圆领基础羊毛衫',
      description: '基础圆领，适合日常批发试穿',
      material: '100% 羊毛',
      levelId: 'pl_vip',
      groupId: 'pg_current',
      priceDisplay: 'show',
      sharePolicy: 'designated_only',
      allowCustomerDownload: false,
      coverMediaIds: [],
      tags: ['基础款', '秋冬'],
      status: 'on_sale',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(demo.id, demo);
    const sku: ProductSkuRec = {
      id: 'sku_demo_001',
      tenantId: demo.tenantId,
      productId: demo.id,
      skuCode: 'WS-2026-001-RED-M',
      color: '酒红',
      size: 'M',
      price: '128.00',
      stock: 50,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.skus.set(sku.id, sku);
  }

  async list(tenantId: string, query: ProductListQuery = {}) {
    let items = [...this.products.values()].filter((p) => p.tenantId === tenantId);
    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter(
        (p) => p.styleNo.toLowerCase().includes(q),
      );
    }
    if (query.levelId) items = items.filter((p) => p.levelId === query.levelId);
    if (query.groupId) items = items.filter((p) => p.groupId === query.groupId);
    if (query.status) items = items.filter((p) => p.status === query.status);
    if (query.tag) items = items.filter((p) => (p.tags || []).includes(query.tag!));
    const rank = (s: string) => (s === 'on_sale' ? 0 : s === 'off_sale' ? 1 : 2);
    items.sort(
      (a, b) =>
        rank(a.status) - rank(b.status) || b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const total = items.length;
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 50));
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total };
  }

  async findById(tenantId: string, id: string) {
    const p = this.products.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    return { ...p };
  }

  async findByStyleNo(tenantId: string, styleNo: string) {
    for (const p of this.products.values()) {
      if (p.tenantId === tenantId && p.styleNo === styleNo) return { ...p };
    }
    return null;
  }

  async create(tenantId: string, input: CreateProductInput) {
    const now = new Date();
    const id = newId('prod');
    const rec: ProductRec = {
      id,
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
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(id, rec);
    for (const sku of input.skus || []) {
      await this.addSku(tenantId, id, sku);
    }
    return { ...rec };
  }

  async update(tenantId: string, id: string, input: UpdateProductInput) {
    const p = this.products.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    Object.assign(p, {
      ...('styleNo' in input && input.styleNo !== undefined ? { styleNo: input.styleNo.trim() } : {}),
      ...('name' in input && input.name !== undefined ? { name: input.name.trim() } : {}),
      ...('description' in input ? { description: input.description ?? null } : {}),
      ...('material' in input ? { material: input.material ?? null } : {}),
      ...('levelId' in input && input.levelId ? { levelId: input.levelId } : {}),
      ...('priceDisplay' in input && input.priceDisplay ? { priceDisplay: input.priceDisplay } : {}),
      ...('sharePolicy' in input ? { sharePolicy: input.sharePolicy ?? null } : {}),
      ...('allowCustomerDownload' in input && input.allowCustomerDownload !== undefined
        ? { allowCustomerDownload: !!input.allowCustomerDownload }
        : {}),
      ...('groupId' in input ? { groupId: input.groupId ?? null } : {}),
      ...('coverMediaIds' in input ? { coverMediaIds: input.coverMediaIds ?? null } : {}),
      ...('tags' in input ? { tags: input.tags ?? null } : {}),
      ...('status' in input && input.status ? { status: input.status } : {}),
      ...('sortOrder' in input && input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: new Date(),
    });
    this.products.set(id, p);
    return { ...p };
  }

  async softOffSale(tenantId: string, id: string) {
    return this.update(tenantId, id, { status: 'off_sale' });
  }

  async batchSetStatus(tenantId: string, ids: string[], status: string) {
    let n = 0;
    for (const id of ids) {
      const p = this.products.get(id);
      if (p && p.tenantId === tenantId) {
        p.status = status as ProductRec['status'];
        p.updatedAt = new Date();
        n++;
      }
    }
    return n;
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
    return [...this.skus.values()].filter(
      (s) => s.tenantId === tenantId && s.productId === productId && s.status !== 'deleted',
    );
  }

  async listSkusByProductIds(tenantId: string, productIds: string[]) {
    const out = new Map<string, ProductSkuRec[]>();
    for (const id of productIds) out.set(id, []);
    const want = new Set(productIds.filter(Boolean));
    if (!want.size) return out;
    for (const s of this.skus.values()) {
      if (s.tenantId !== tenantId || s.status === 'deleted' || !want.has(s.productId)) continue;
      const list = out.get(s.productId) || [];
      list.push({ ...s });
      out.set(s.productId, list);
    }
    return out;
  }

  async findSku(tenantId: string, skuId: string) {
    const s = this.skus.get(skuId);
    if (!s || s.tenantId !== tenantId) return null;
    return { ...s };
  }

  async addSku(tenantId: string, productId: string, input: CreateSkuInput) {
    const now = new Date();
    const color = input.color ?? null;
    const size = input.size ?? null;
    const skuCode =
      input.skuCode?.trim() ||
      `${productId.slice(-6)}-${(color || 'NA').slice(0, 8)}-${(size || 'NA').slice(0, 8)}-${Date.now().toString(36)}`;
    const rec: ProductSkuRec = {
      id: newId('sku'),
      tenantId,
      productId,
      skuCode,
      color,
      size,
      price: input.price != null ? String(input.price) : null,
      stock: input.stock ?? 0,
      status: input.status || 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.skus.set(rec.id, rec);
    return { ...rec };
  }

  async updateSku(tenantId: string, skuId: string, input: Partial<CreateSkuInput>) {
    const s = this.skus.get(skuId);
    if (!s || s.tenantId !== tenantId) return null;
    if (input.skuCode !== undefined) s.skuCode = input.skuCode.trim();
    if ('color' in input) s.color = input.color ?? null;
    if ('size' in input) s.size = input.size ?? null;
    if ('price' in input) s.price = input.price != null ? String(input.price) : null;
    if (input.stock !== undefined) s.stock = input.stock;
    if (input.status) s.status = input.status;
    s.updatedAt = new Date();
    this.skus.set(skuId, s);
    return { ...s };
  }

  async removeSku(tenantId: string, skuId: string) {
    const s = this.skus.get(skuId);
    if (!s || s.tenantId !== tenantId) return false;
    const base = String(s.skuCode || 'sku').slice(0, 40);
    s.skuCode = `${base}__del__${String(s.id).slice(0, 8)}`;
    s.status = 'deleted';
    s.updatedAt = new Date();
    return true;
  }

  async reviveSkuByCode(
    tenantId: string,
    productId: string,
    skuCode: string,
    input: CreateSkuInput,
  ) {
    for (const s of this.skus.values()) {
      if (s.tenantId !== tenantId || s.productId !== productId || s.status !== 'deleted') continue;
      if (s.skuCode === skuCode || String(s.skuCode || '').startsWith(`${skuCode}__del__`)) {
        s.skuCode = skuCode;
        s.color = input.color ?? null;
        s.size = input.size ?? null;
        s.price = input.price != null ? String(input.price) : null;
        s.stock = input.stock ?? 0;
        s.status = input.status || 'active';
        s.updatedAt = new Date();
        this.skus.set(s.id, s);
        return { ...s };
      }
    }
    return null;
  }
}
