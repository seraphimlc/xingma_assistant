/**
 * 从商品图里挑试衣用的成衣图。
 * 只要挂拍/平铺、上身、以及看不出是文档的商品图。
 * 尺码表、吊牌/水洗标、检测报告一律不用。
 * 某色没有专图时复用最佳主图，不生成新的色图。
 */

export interface TryOnImageInput {
  id: string;
  url: string;
  objectKey?: string;
  filename?: string;
  type?: string;
  mimeType?: string | null;
  isPromo?: boolean;
  coverIndex?: number;
  localPath?: string;
  meta?: Record<string, unknown> | null;
  /** 本地像素看起来像白底文档（尺码表/报告） */
  documentLike?: boolean;
}

export interface TryOnSkuInput {
  id: string;
  color: string | null;
  status?: string;
}

export interface SelectedTryOnColor {
  id: string;
  name: string;
  mediaId: string;
  sourceUrl: string;
  objectKey: string;
  localPath?: string;
}

export type TryOnImageClass = 'hang' | 'on_body' | 'multi' | 'detail' | 'unknown' | 'forbid';

const FORBIDDEN_ROLE = new Set([
  'hangtag',
  'size_chart',
  'lab_report',
  'packaging',
  'coupon',
  'text',
  'document',
]);

const FORBIDDEN_NAME =
  /尺码|尺寸表|size[\s._-]*chart|质检|检验报告|检测报告|合规报告|lab[\s._-]*report|test[\s._-]*report|吊牌|水洗标|成分标|合格证|hangtag|care[\s._-]*label|wash[\s._-]*label|coupon|优惠券|包装袋|快递袋/i;

const SCORE: Record<Exclude<TryOnImageClass, 'forbid'>, number> = {
  hang: 100,
  on_body: 80,
  multi: 70,
  unknown: 58,
  detail: 40,
};

function basename(value: string): string {
  const clean = String(value || '').split('?')[0].split('#')[0];
  const parts = clean.split('/');
  return parts[parts.length - 1] || '';
}

function metaText(meta: Record<string, unknown> | null | undefined, key: string): string {
  const v = meta?.[key];
  return v == null ? '' : String(v).trim();
}

export function publicProductName(name: string | null | undefined): string {
  const stripped = String(name || '')
    .replace(/V\d{12}[A-Z0-9]{0,8}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || '商品';
}

/** 单张图分类。forbid 表示不能拿去试衣。 */
export function classifyTryOnImage(img: TryOnImageInput): TryOnImageClass {
  const name = img.filename || basename(img.objectKey || img.url || '');
  const role = metaText(img.meta, 'role').toLowerCase();
  const kind = metaText(img.meta, 'kind').toLowerCase();
  const roleZh = metaText(img.meta, 'roleZh');
  const mime = String(img.mimeType || '').toLowerCase();

  if (img.type && img.type !== 'image') return 'forbid';
  if (mime && !mime.startsWith('image/')) return 'forbid';
  if (FORBIDDEN_ROLE.has(role)) return 'forbid';
  if (FORBIDDEN_NAME.test(name) || FORBIDDEN_NAME.test(roleZh)) return 'forbid';
  if (kind === 'grid_cell') return 'forbid';
  if (kind === 'unusable') {
    if (/模特|上身|街拍|lookbook/.test(roleZh)) return 'on_body';
    return 'forbid';
  }
  if (img.documentLike && role !== 'main' && role !== 'on_model' && role !== 'detail' && kind !== 'hang' && kind !== 'detail') {
    return 'forbid';
  }

  if (role === 'main' || kind === 'hang' || /平铺|挂拍|flat[\s._-]*lay|主图|封面|\bmain\b|\bcover\b/i.test(name)) {
    return 'hang';
  }
  if (role === 'on_model' || /上身|真人|模特|街拍|lookbook|\bmodel\b/i.test(name)) return 'on_body';
  if (role === 'multi_color' || kind === 'multi_color') return 'multi';
  if (role === 'detail' || kind === 'detail' || /细节|领口|袖口|织纹|close[\s._-]*up/i.test(name)) return 'detail';
  if (img.documentLike) return 'forbid';
  return 'unknown';
}

function usabilityScore(img: TryOnImageInput, index: number): number | null {
  const kind = classifyTryOnImage(img);
  if (kind === 'forbid') return null;
  let score = SCORE[kind];
  if (img.isPromo) score -= 22;
  const cover = img.coverIndex == null ? index : img.coverIndex;
  score += Math.max(0, 12 - Math.min(cover, 12));
  return score;
}

function normColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function colorHint(img: TryOnImageInput): string {
  return normColor(metaText(img.meta, 'colorHint') || metaText(img.meta, 'color'));
}

function matchesColor(img: TryOnImageInput, color: string): boolean {
  const wanted = normColor(color);
  if (!wanted) return false;
  const hint = colorHint(img);
  if (hint && hint === wanted) return true;
  if (wanted.length < 2) return false;
  const name = (img.filename || basename(img.objectKey || '')).toLowerCase();
  return name.includes(wanted);
}

function bestOf(images: TryOnImageInput[], pool: Array<{ img: TryOnImageInput; score: number; index: number }>): TryOnImageInput | null {
  const ids = new Set(images.map((img) => img.id));
  const rows = pool.filter((row) => ids.has(row.img.id));
  if (!rows.length) return null;
  rows.sort((a, b) => b.score - a.score || a.index - b.index);
  return rows[0].img;
}

function toSelected(id: string, name: string, img: TryOnImageInput): SelectedTryOnColor {
  return {
    id,
    name,
    mediaId: img.id,
    sourceUrl: img.url,
    objectKey: img.objectKey || '',
    localPath: img.localPath,
  };
}

/**
 * 按在售颜色选出试衣图。没有颜色 SKU 时，有可用成衣图则给一枚「默认」。
 * 返回空数组表示按钮应隐藏。
 */
export function selectTryOnColors(images: TryOnImageInput[], skus: TryOnSkuInput[]): SelectedTryOnColor[] {
  const usableAll = images
    .map((img, index) => {
      const score = usabilityScore(img, index);
      return score == null ? null : { img, score, index };
    })
    .filter((row): row is { img: TryOnImageInput; score: number; index: number } => !!row);
  if (!usableAll.length) return [];
  // 有实拍成衣图时不用宣传成片，避免把走秀/生图结果当成试衣底图。
  const real = usableAll.filter((row) => !row.img.isPromo);
  const usable = real.length ? real : usableAll;

  const ranked = [...usable].sort((a, b) => b.score - a.score || a.index - b.index);
  const main = ranked[0].img;

  const colors: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const sku of skus) {
    if (sku.status && sku.status !== 'active') continue;
    const name = String(sku.color || '').trim();
    if (!name) continue;
    const key = normColor(name);
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({ id: sku.id, name });
  }

  if (!colors.length) {
    return [toSelected('default', '默认', main)];
  }

  return colors.map((color) => {
    const dedicated = usable
      .map((row) => row.img)
      .filter((img) => matchesColor(img, color.name));
    const picked = bestOf(dedicated, usable) || main;
    return toSelected(color.id, color.name, picked);
  });
}

export function toPublicTryOnDto(
  name: string | null | undefined,
  productId: string,
  colors: SelectedTryOnColor[],
): { name: string; available: boolean; colors: Array<{ id: string; name: string; imageUrl: string }> } {
  const pub = colors
    .filter((c) => c.sourceUrl || c.localPath)
    .map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: `/api/tryon/garment?productId=${encodeURIComponent(productId)}&colorId=${encodeURIComponent(c.id)}`,
    }));
  return {
    name: publicProductName(name),
    available: pub.length > 0,
    colors: pub,
  };
}
