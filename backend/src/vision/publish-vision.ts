import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { VisionClient, VisionContentPart } from './vision.client';

const logger = new Logger('PublishVision');

export interface VisionTitleResult {
  title: string;
  subtitle?: string;
  via: 'vision' | 'fallback';
  reason: string;
}

export interface VisionColorsResult {
  colors: string[];
  via: 'vision' | 'none';
  reason: string;
}

function parseJsonLoose(text: string): any {
  const t = (text || '').trim();
  if (!t) throw new Error('空响应');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : t;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`无 JSON: ${t.slice(0, 120)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeTitle(raw: string): string {
  let t = String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["""'']/g, '')
    .replace(/\s+/g, '')
    .trim();
  // 去掉常见无用前后缀
  t = t.replace(/^(标题|商品名|款式)[：:]\s*/i, '');
  if (t.length > 24) t = t.slice(0, 24);
  return t;
}

function sanitizeSubtitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let t = String(raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t === 'null' || t === '无') return undefined;
  if (t.length > 40) t = t.slice(0, 40);
  return t;
}

function normalizeVisionColors(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    let c = String(item || '')
      .replace(/\s+/g, '')
      .trim();
    if (!c || /^色\d+$/.test(c)) continue;
    if (c === '黑') c = '黑色';
    if (c === '白') c = '白色';
    if (c === '灰') c = '灰色';
    // 限制长度，避免模型胡写长句
    if (c.length > 8) continue;
    if (!/[\u4e00-\u9fff]/.test(c)) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, 12);
}

/**
 * 根据成衣商品图（可多张，非吊牌）生成中文商品标题。
 * 无吊牌/OCR 清晰品名时应走此路径，勿用文件名占位。
 * 失败时返回兜底标题，保证非空。
 */
export async function generateProductTitle(
  vision: VisionClient,
  localPaths: string | string[],
  opts?: { styleNo?: string },
): Promise<VisionTitleResult> {
  const fallback = opts?.styleNo
    ? `款号 ${opts.styleNo}`
    : '针织上衣';
  const paths = (Array.isArray(localPaths) ? localPaths : [localPaths])
    .filter((p) => p && fs.existsSync(p))
    .slice(0, 4);
  if (!paths.length) {
    return { title: fallback, via: 'fallback', reason: '商品图不存在' };
  }
  if (!vision.configured()) {
    return { title: fallback, via: 'fallback', reason: '未配置 VISION_API_KEY' };
  }
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `你是羊毛衫档口电商助手。根据成衣商品图（可能多张），写一条中文商品标题（款式描述）。
要求：
- title：8～16 个汉字，描述领型/袖长/版型/面料观感，例如「圆领短袖净色针织」「半高领宽松绞花毛衣」
- 综合多张图的共性款式，不要只看背景或吊牌文字
- 不要写品牌、价格、尺码、颜色枚举、营销词（爆款/新款/包邮）、不要用文件名
- 不要空 title
- subtitle 可选：一句补充材质或细节（≤20字），没有则 null
只回一行 JSON：{"title":"圆领短袖净色针织","subtitle":null}`,
      },
    ];
    for (let i = 0; i < paths.length; i++) {
      parts.push({
        type: 'text',
        text: `image_${i} file=${path.basename(paths[i])}`,
      });
      parts.push({
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(paths[i]) },
      });
    }
    const content = await vision.chat(parts, { maxTokens: 200, temperature: 0.2 });
    const parsed = parseJsonLoose(content);
    const title = sanitizeTitle(parsed.title);
    const subtitle = sanitizeSubtitle(parsed.subtitle);
    if (!title) {
      return { title: fallback, via: 'fallback', reason: 'vision 标题为空' };
    }
    return {
      title,
      subtitle,
      via: 'vision',
      reason: subtitle
        ? `vision+副标题 (${paths.length}图)`
        : `vision (${paths.length}图)`,
    };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`生成标题失败: ${msg}`);
    return { title: fallback, via: 'fallback', reason: `vision失败: ${msg}` };
  }
}

/**
 * 从主图/多色挂拍估主色名列表（中文常见色名）。
 */
export async function estimateGarmentColors(
  vision: VisionClient,
  localPaths: string[],
): Promise<VisionColorsResult> {
  const paths = (localPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 4);
  if (!paths.length) {
    return { colors: [], via: 'none', reason: '无可用图片' };
  }
  if (!vision.configured()) {
    return { colors: [], via: 'none', reason: '未配置 VISION_API_KEY' };
  }
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `你是羊毛衫档口助手。根据图中成衣，列出可见的主色名称（中文）。
规则：
- colors：字符串数组，用档口常见色名（如黑色、米白、驼色、花灰、酒红、军绿），1～8 个
- 多色挂拍图请列出每件可见颜色；单色主图只列主色
- 不要「色1」占位，不要英文，不要材质/款式词
只回一行 JSON：{"colors":["黑色","米白","驼色"]}`,
      },
    ];
    for (let i = 0; i < paths.length; i++) {
      parts.push({
        type: 'text',
        text: `image_${i} file=${path.basename(paths[i])}`,
      });
      parts.push({
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(paths[i]) },
      });
    }
    const content = await vision.chat(parts, { maxTokens: 300, temperature: 0 });
    const parsed = parseJsonLoose(content);
    const colors = normalizeVisionColors(parsed.colors);
    if (!colors.length) {
      return { colors: [], via: 'none', reason: 'vision 未返回有效色名' };
    }
    return { colors, via: 'vision', reason: `vision 估色 ${colors.length} 个` };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`估色失败: ${msg}`);
    return { colors: [], via: 'none', reason: `vision失败: ${msg}` };
  }
}

/** 是否弱标题（需 vision 补全） */
export function isWeakProductTitle(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  if (!n) return true;
  if (n === '新款羊毛衫' || n === '未命名' || n === '针织上衣' || n === '羊毛衫') return true;
  if (/^识别中/.test(n)) return true;
  if (/^款号\s*\S+$/.test(n)) return true;
  // 纯数字/文件名式占位
  if (/^\d{4,8}$/.test(n)) return true;
  if (/\.(jpg|jpeg|png|webp|heic)$/i.test(n)) return true;
  return false;
}

/** 临时款号（enqueue 草稿）：V + yyyymmddHHMM + tail */
export function isProvisionalStyleNo(styleNo: string | null | undefined): boolean {
  const s = String(styleNo || '').trim();
  return /^V\d{12}[A-Z0-9]{0,8}$/i.test(s);
}

/** 是否仅占位色名 */
export function isPlaceholderColorList(colors: string[] | null | undefined): boolean {
  const list = colors || [];
  if (!list.length) return true;
  return list.every((c) => !c || /^色\d+$/.test(c));
}

/** 无款号时生成临时款号，便于落库；需 needReview */
export function provisionalStyleNo(batchId?: string): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const tail = String(batchId || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
  return `V${stamp}${tail || Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * 用 xytoken 多模态识图读文字（吊牌/角标/多色挂拍色名）。
 * 失败返回空文案 + note，不抛错。
 */
export async function ocrImageText(
  vision: VisionClient,
  localPath: string,
): Promise<{ text: string; note: string; via: 'multimodal' | 'none' }> {
  if (!localPath || !fs.existsSync(localPath)) {
    return { text: '', note: '文件不存在', via: 'none' };
  }
  if (!vision.configured()) {
    return { text: '', note: '未配置 VISION_API_KEY', via: 'none' };
  }
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `请完整识别这张图片中的所有可见文字（中文、数字、英文），按阅读顺序输出纯文本。
特别关注吊牌/笔记字段：款号、成分、材质、颜色、尺码、克重、款式。
多色挂拍或竖排色标请尽量读出各色名。
不要解释、不要 JSON、不要 markdown；若几乎无字只输出空。`,
      },
      {
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(localPath, 1024, 75) },
      },
    ];
    const content = await vision.chat(parts, { maxTokens: 900, temperature: 0 });
    const text = String(content || '')
      .replace(/^```[\s\S]*?```$/g, '')
      .trim();
    return {
      text,
      note: text
        ? `xytoken 多模态 OCR (${vision.model})`
        : '多模态 OCR 无有效文字',
      via: 'multimodal',
    };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`多模态 OCR 失败: ${msg}`);
    return { text: '', note: `多模态 OCR 失败: ${msg}`, via: 'none' };
  }
}


/** 选图发品锁定 8 类（与 publish.types ImageRole 对齐，不含 unknown） */
export const PUBLISH_VISION_ROLE_CODES = [
  'main',
  'detail',
  'hangtag',
  'size_chart',
  'lab_report',
  'on_model',
  'packaging',
  'multi_color',
] as const;

export type PublishVisionRoleCode = (typeof PUBLISH_VISION_ROLE_CODES)[number];

const ROLE_ALIASES: Record<string, PublishVisionRoleCode | 'unknown'> = {
  main: 'main',
  hang_flat: 'main',
  hang: 'main',
  flatlay: 'main',
  flat_lay: 'main',
  挂拍: 'main',
  平铺: 'main',
  detail: 'detail',
  closeup: 'detail',
  细节: 'detail',
  hangtag: 'hangtag',
  label: 'hangtag',
  care_label: 'hangtag',
  wash_label: 'hangtag',
  吊牌: 'hangtag',
  水洗标: 'hangtag',
  size_chart: 'size_chart',
  sizechart: 'size_chart',
  尺码表: 'size_chart',
  lab_report: 'lab_report',
  labreport: 'lab_report',
  compliance: 'lab_report',
  test_report: 'lab_report',
  检测报告: 'lab_report',
  质检: 'lab_report',
  on_model: 'on_model',
  model: 'on_model',
  scene: 'on_model',
  lookbook: 'on_model',
  上身: 'on_model',
  模特: 'on_model',
  packaging: 'packaging',
  package: 'packaging',
  bag: 'packaging',
  包装: 'packaging',
  袋装: 'packaging',
  multi_color: 'multi_color',
  color_card: 'multi_color',
  swatch: 'multi_color',
  色卡: 'multi_color',
  多色: 'multi_color',
  unknown: 'unknown',
  other: 'unknown',
  none: 'unknown',
  unusable: 'unknown',
};

export function normalizePublishImageRole(
  raw: string | null | undefined,
): PublishVisionRoleCode | 'unknown' {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!s) return 'unknown';
  if ((PUBLISH_VISION_ROLE_CODES as readonly string[]).includes(s)) {
    return s as PublishVisionRoleCode;
  }
  for (const [k, v] of Object.entries(ROLE_ALIASES)) {
    if (s === k || s.includes(k)) return v;
  }
  return 'unknown';
}

export interface PublishRoleClassifyItem {
  mediaId: string;
  localPath: string;
  filename?: string;
}

export interface PublishRoleClassifyResult {
  mediaId: string;
  role: PublishVisionRoleCode | 'unknown';
  confidence: number;
  reason: string;
}

/**
 * 多模态把选图发品图片归入锁定 8 类；不在枚举内 → unknown。
 * 失败时返回空数组（调用方保留启发式结果）。
 */
export async function classifyPublishImageRoles(
  vision: VisionClient,
  items: PublishRoleClassifyItem[],
): Promise<PublishRoleClassifyResult[]> {
  const pool = (items || []).filter((it) => it?.localPath && fs.existsSync(it.localPath)).slice(0, 12);
  if (!pool.length) return [];
  if (!vision.configured()) return [];
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `你是羊毛衫档口「选图发品」识图助手。共 ${pool.length} 张图（index 0..${pool.length - 1}）。
请把每张图归入下列【唯一】类型之一（英文 code）。命中任意一类即算商品资料图，不要求批次齐全。

锁定类型（只能用这些 code）：
1. main — 挂拍图（含平铺）：整件成衣挂拍/平铺/静物，无人或几乎不见模特脸
2. detail — 细节图：面料、织纹、领口、袖口、工艺特写
3. hangtag — 商品吊牌/标签（含水洗标、成分标）
4. size_chart — 尺码表/尺寸表
5. lab_report — 检测/合规/质检/检验报告
6. on_model — 上身效果图：真人/模特穿着展示
7. packaging — 包装/袋装/盒装展示
8. multi_color — 色卡/多色对照（多件并排或色卡）
若不是服装商品资料（自拍、风景、餐饮、截图聊天、无关物体等）→ unknown

只回一行 JSON：
{"items":[{"index":0,"role":"main","confidence":0.9,"reason":"整件挂拍"},{"index":1,"role":"unknown","confidence":0.8,"reason":"不是商品资料图"}]}`,
      },
    ];
    for (let i = 0; i < pool.length; i++) {
      parts.push({
        type: 'text',
        text: `index=${i} file=${pool[i].filename || path.basename(pool[i].localPath)} id=${pool[i].mediaId}`,
      });
      parts.push({
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(pool[i].localPath, 1024, 75) },
      });
    }
    const content = await vision.chat(parts, { maxTokens: 800, temperature: 0 });
    const parsed = parseJsonLoose(content);
    const arr = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
    const out: PublishRoleClassifyResult[] = [];
    for (const row of arr) {
      const idx = Number(row?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) continue;
      const role = normalizePublishImageRole(row?.role);
      let conf = Number(row?.confidence);
      if (!Number.isFinite(conf)) conf = role === 'unknown' ? 0.7 : 0.75;
      conf = Math.max(0, Math.min(1, conf));
      out.push({
        mediaId: pool[idx].mediaId,
        role,
        confidence: conf,
        reason: String(row?.reason || '').slice(0, 80),
      });
    }
    return out;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`classifyPublishImageRoles 失败: ${msg}`);
    return [];
  }
}
