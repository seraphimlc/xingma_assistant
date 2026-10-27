/**
 * 选图发品分析：先分类图角色，再抽吊牌字段 / 多色挂拍颜色。
 * OCR 主路径：xytoken 多模态（VISION_* / Aerith-haiku）；
 * Mac Vision OCR（scripts/vision_ocr）仅当 ENABLE_MAC_VISION_OCR=1 时作可选兜底；
 * 再降级 tesseract / 启发式。OCR 失败不阻断，仍返回可编辑草案。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {
  ColorSkuDraft,
  ImageRole,
  ImageSuggestion,
  PublishBatchAsset,
  PublishSuggestion,
  ColorSuggestionSource,
  isRecognizedPublishImageRole,
} from './publish.types';
import {
  isSparseColorList,
  lookupColorsFromNotes,
  mergeColorsPreferOcr,
  StyleColorLookup,
} from './publish-color-lookup';
import { Logger } from '@nestjs/common';
import { VisionClient } from '../../vision/vision.client';

const analyzeLogger = new Logger('PublishAnalyze');
import {
  ocrImageText,
  classifyPublishImageRoles,
  normalizePublishImageRole,
} from '../../vision/publish-vision';

const execFileAsync = promisify(execFile);

/** 羊毛衫档口常见色名（含笔记/挂拍出现过的）——长词优先匹配 */
const COMMON_COLORS = [
  '欧柏绿', '洋红紫', '珍珠杏', '橄榄绿', '红焦糖', '中麻灰', '新翠绿', '太空岩',
  '暗橙红', '伦敦雾', '沙漠驼', '平上青', '马鞍棕', '深麻灰', '浅浅灰', '浅军绿',
  '童浅兰', '沙海蓝', '花石灰', '夹花驼AB', '夹花灰AB', 'AB驼棕', '麦香驼', '黑曜石', '茶语色', '月光色', '深谷绿', '檀木色', '黑上青',
  '米灰', '米驼', '米白', '奶白', '乳白', '焦糖', '燕麦', '香槟', '奶茶',
  '草绿', '烟紫', '兰色', '兰棕', '上青', '藏青', '天蓝', '浅蓝', '深蓝',
  '墨绿', '军绿', '浅绿', '酒红', '玫红', '粉红', '粉色', '枣红',
  '卡其', '驼色', '咖啡', '咖啡色', '棕色', '褐色', '靓褐', '淡黄',
  '花灰', '深灰', '浅灰', '灰色', '黑色', '白色', '红色', '橘色', '橙色',
  '黄色', '绿色', '蓝色', '紫色', '杏色', '裸粉', '黑', '白', '灰',
].sort((a, b) => b.length - a.length);

/** 仅 ENABLE_MAC_VISION_OCR=1 时启用本机 macOS Vision OCR（线上 Linux 切勿开） */
function macVisionOcrEnabled(): boolean {
  return String(process.env.ENABLE_MAC_VISION_OCR || '').trim() === '1';
}

function resolveVisionBin(): string | null {
  if (!macVisionOcrEnabled()) return null;
  if (process.platform !== 'darwin' && !process.env.VISION_OCR_PATH) return null;
  const env = process.env.VISION_OCR_PATH;
  const candidates = [
    env,
    path.join(process.cwd(), 'scripts', 'vision_ocr'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'vision_ocr'),
    '/tmp/vision_ocr',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolveStripsScript(): string | null {
  const candidates = [
    path.join(process.cwd(), 'scripts', 'vision_ocr_strips.py'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'vision_ocr_strips.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 解析【字段】笔记/吊牌文案 */
export function parseBracketFields(text: string): Record<string, string> {
  if (!text) return {};
  const parts = text.split(/【([^】]+)】[：:]?\s*/);
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    const val = (parts[i + 1] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/【/)[0]
      .trim();
    if (label) out[label] = val;
  }
  return out;
}

export function splitColors(raw: string): string[] {
  if (!raw) return [];
  const parts = raw.includes('/')
    ? raw.split('/')
    : raw.split(/[,，、\s]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

function isSizeChartText(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  const hits = ['尺码', '衣长', '胸围', '肩宽', '袖长', '成衣尺寸'].filter((k) =>
    t.includes(k),
  ).length;
  return hits >= 2;
}

function isLabReportText(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return (
    t.includes('检验报告') ||
    t.includes('TESTREPORT') ||
    (t.includes('纤维') && t.includes('检测'))
  );
}

function guessRoleFromFilename(name: string): { role: ImageRole; confidence: number } {
  const n = (name || '').toLowerCase();
  if (/吊牌|水洗标|标签|hangtag|care.?label|wash.?label/.test(n))
    return { role: 'hangtag', confidence: 0.85 };
  if (/尺码|尺寸表|size.?chart/.test(n)) return { role: 'size_chart', confidence: 0.85 };
  if (/质检|检验报告|检测报告|合规|lab.?report|test.?report/.test(n))
    return { role: 'lab_report', confidence: 0.85 };
  if (/包装|袋装|盒装|包装袋|packag|polybag|袋装展示/.test(n))
    return { role: 'packaging', confidence: 0.8 };
  if (/色卡|多色|合照|群组|multicolor|swatch|color.?card/.test(n))
    return { role: 'multi_color', confidence: 0.8 };
  if (/细节|领口|袖口|面料|工艺|detail|close.?up/.test(n))
    return { role: 'detail', confidence: 0.75 };
  if (/场景|模特|上身|街拍|lookbook|on.?model|\bmodel\b/.test(n) && !/挂拍|平铺|主图/.test(n)) {
    return { role: 'on_model', confidence: 0.75 };
  }
  if (/主图|封面|main|cover|平铺|挂拍/.test(n)) return { role: 'main', confidence: 0.7 };
  return { role: 'unknown', confidence: 0.2 };
}

function countColorHits(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  const usedRanges: Array<[number, number]> = [];
  for (const c of COMMON_COLORS) {
    let from = 0;
    while (true) {
      const i = text.indexOf(c, from);
      if (i < 0) break;
      const end = i + c.length;
      const overlap = usedRanges.some(([a, b]) => !(end <= a || i >= b));
      if (!overlap) {
        found.push(c);
        usedRanges.push([i, end]);
        break;
      }
      from = i + 1;
    }
  }
  return found;
}

function guessRoleFromOcr(
  text: string,
  meta?: { width?: number; height?: number; sizeBytes?: number },
): { role: ImageRole; confidence: number } | null {
  if (!text || text.trim().length < 2) {
    // 无文字的横向大图：疑似多色挂拍
    if (meta?.width && meta?.height && meta.width > meta.height * 1.15 && (meta.sizeBytes || 0) > 200000) {
      return { role: 'multi_color', confidence: 0.55 };
    }
    return null;
  }
  if (isSizeChartText(text)) {
    return { role: 'size_chart', confidence: 0.85 };
  }
  if (isLabReportText(text)) {
    return { role: 'lab_report', confidence: 0.85 };
  }
  const t = text.replace(/\s+/g, '');
  const fieldHits = ['款号', '成分', '材质', '颜色', '尺码', '克重', '款式'].filter((k) =>
    t.includes(k),
  ).length;
  if (fieldHits >= 2 || /【款号】|【成分】|【颜色】/.test(text)) {
    return { role: 'hangtag', confidence: 0.9 };
  }
  // 「款号：xxx | 颜色：yyy」挂牌文案
  if (/款号[：:]/.test(text) && (/颜色[：:]/.test(text) || /成分|山羊绒|羊毛|腈纶|锦纶/.test(text))) {
    return { role: 'hangtag', confidence: 0.82 };
  }
  const colors = countColorHits(text);
  if (colors.length >= 2) return { role: 'multi_color', confidence: 0.8 };
  // 单色主图角标：款号 + 单色名（优先于多色挂拍启发式）
  // 排除带 SIN MA / 分条残留的挂拍图
  if (
    /\d{4,6}/.test(text) &&
    colors.length === 1 &&
    text.length < 48 &&
    !/SIN\s*MA|\bMA\b|IN\s*MA/i.test(text)
  ) {
    return { role: 'main', confidence: 0.78 };
  }
  // 款号水印 + 几乎无业务字段（含竖图三件挂拍）→ 多色挂拍
  // 仅数字/拉丁（无中文业务字）才当水印图；短中文色名如「白色」不能算水印
  const nonCJK = text.replace(/[\d.\s|A-Za-z·。．]/g, '');
  const watermarky =
    /SIN\s*MA/i.test(text) ||
    (nonCJK.length === 0 && /\d{5,6}/.test(text));
  if (
    /\d{4,6}/.test(text) &&
    !isSizeChartText(text) &&
    !/成分|材质|颜色[：:]|【颜色】|克重|款式/.test(text) &&
    (meta?.sizeBytes || 0) > 150000 &&
    (watermarky ||
      (meta?.width && meta?.height && meta.width > meta.height * 1.05) ||
      colors.length >= 1)
  ) {
    // 单色角标主图（短文案 款号+色名）在下面处理
    if (!(colors.length === 1 && text.length < 40 && !watermarky)) {
      return { role: 'multi_color', confidence: 0.68 };
    }
  }
  // 横向大图兜底
  if (
    meta?.width &&
    meta?.height &&
    meta.width > meta.height * 1.1 &&
    /\d{4,6}/.test(text) &&
    !isSizeChartText(text) &&
    (meta.sizeBytes || 0) > 150000
  ) {
    return { role: 'multi_color', confidence: 0.65 };
  }
  // 单色主图角标：款号 + 单色名
  if (
    /\d{4,6}/.test(text) &&
    colors.length === 1 &&
    text.length < 40 &&
    !/SIN\s*MA|\bMA\b|IN\s*MA/i.test(text)
  ) {
    return { role: 'main', confidence: 0.75 };
  }
  // 分条 OCR 残留水印（MA/SIN）+ 款号 → 多色挂拍（即使只抽出 1 个色名）
  if (
    /\d{4,6}/.test(text) &&
    /(?:SIN\s*MA|\bMA\b|IN\s*MA)/i.test(text) &&
    !isSizeChartText(text) &&
    (meta?.sizeBytes || 0) > 200000
  ) {
    return { role: 'multi_color', confidence: 0.72 };
  }
  return null;
}

async function readImageMeta(
  localPath: string,
): Promise<{ width?: number; height?: number }> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'sips',
        ['-g', 'pixelWidth', '-g', 'pixelHeight', localPath],
        { timeout: 5000 },
      );
      let width: number | undefined;
      let height: number | undefined;
      for (const line of (stdout || '').split('\n')) {
        if (line.includes('pixelWidth')) width = parseInt(line.split(':').pop() || '', 10);
        if (line.includes('pixelHeight')) height = parseInt(line.split(':').pop() || '', 10);
      }
      if (width && height) return { width, height };
    } catch {
      /* fall through */
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-c',
        'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(im.size[0], im.size[1])',
        localPath,
      ],
      { timeout: 8000 },
    );
    const parts = (stdout || '').trim().split(/\s+/);
    const width = parseInt(parts[0] || '', 10);
    const height = parseInt(parts[1] || '', 10);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    /* ignore */
  }
  return {};
}

async function tryMacVisionOcr(localPath: string): Promise<{ text: string; note: string } | null> {
  const bin = resolveVisionBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, [localPath], {
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = (stdout || '').trim();
    return { text, note: text ? 'macOS Vision OCR (zh-Hans)' : 'macOS Vision OCR 无有效文字' };
  } catch {
    // 返回 null 让上层继续降级（勿把 Exec format error 当成已完成 OCR）
    return null;
  }
}

async function tryVisionStripOcr(
  localPath: string,
  stripHint?: number,
): Promise<{ text: string; note: string } | null> {
  const bin = resolveVisionBin();
  const script = resolveStripsScript();
  if (!bin || !script) return null;
  try {
    const args = [script, localPath, bin];
    if (stripHint) args.push(String(stripHint));
    const { stdout } = await execFileAsync('python3', args, {
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = (stdout || '').trim();
    return {
      text,
      note: text
        ? `Vision 分条 OCR（竖排色标）`
        : 'Vision 分条 OCR 无有效文字',
    };
  } catch (e: any) {
    return { text: '', note: `分条 OCR 失败: ${e?.message || e}` };
  }
}

async function tryTesseract(localPath: string): Promise<{ text: string; note: string }> {
  const bin = process.env.TESSERACT_PATH || 'tesseract';
  for (const lang of ['chi_sim+eng', 'chi_sim', 'eng']) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        [localPath, 'stdout', '-l', lang, '--psm', '6'],
        { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      );
      const text = (stdout || '').trim();
      return {
        text,
        note: text
          ? `tesseract ${lang}`
          : `tesseract ${lang} 无文字`,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (lang === 'eng') {
        return { text: '', note: `OCR 不可用: ${msg}` };
      }
      // 无中文包则试下一个
    }
  }
  return { text: '', note: 'tesseract 不可用' };
}

async function tryOcr(
  localPath: string,
  opts?: {
    preferStrips?: boolean;
    stripHint?: number;
    vision?: VisionClient;
  },
): Promise<{
  text: string;
  used: boolean;
  note: string;
  engine: 'multimodal' | 'mac_vision' | 'tesseract' | 'none';
}> {
  if (!localPath || !fs.existsSync(localPath)) {
    return { text: '', used: false, note: '文件不存在，跳过 OCR', engine: 'none' };
  }

  // 1) 主路径：xytoken 多模态
  if (opts?.vision?.configured()) {
    try {
      const mm = await ocrImageText(opts.vision, localPath);
      if (mm.text) {
        let combined = mm.text;
        let note = mm.note;
        if (opts?.preferStrips && macVisionOcrEnabled()) {
          const strips = await tryVisionStripOcr(localPath, opts.stripHint);
          if (strips?.text) {
            combined = [combined, strips.text].filter(Boolean).join(' | ');
            note = `${note}; ${strips.note}`;
          }
        }
        return { text: combined, used: true, note, engine: 'multimodal' };
      }
      // 多模态无字或软失败：继续 Mac/tesseract 兜底（线上通常无 Mac）
    } catch (e: any) {
      // 软失败，继续兜底
    }
  }

  // 2) 可选：本机 macOS Vision OCR
  const mac = await tryMacVisionOcr(localPath);
  if (mac) {
    let combined = mac.text;
    let note = mac.note;
    if (opts?.preferStrips) {
      const strips = await tryVisionStripOcr(localPath, opts.stripHint);
      if (strips?.text) {
        combined = [combined, strips.text].filter(Boolean).join(' | ');
        note = `${note}; ${strips.note}`;
      } else if (strips) {
        note = `${note}; ${strips.note}`;
      }
    }
    return { text: combined, used: true, note, engine: 'mac_vision' };
  }

  // 3) tesseract
  const tess = await tryTesseract(localPath);
  return {
    text: tess.text,
    used: !!tess.text || tess.note.includes('tesseract'),
    note: tess.note + '（多模态/Mac Vision 不可用，已降级）',
    engine: 'tesseract',
  };
}

/** 从 OCR 文本抽颜色：【颜色】字段 / 「颜色：」 / 词典 / 款号角标旁色名 */
export function extractColorsFromText(text: string): string[] {
  if (!text) return [];
  const fields = parseBracketFields(text);
  const fromField = splitColors(fields['颜色'] || '');
  if (fromField.length) return normalizeColorList(fromField);

  const m = text.match(/颜色[：:\s]*([^\n|]+)/);
  if (m) {
    const parts = splitColors(m[1]);
    if (parts.length) return normalizeColorList(parts);
  }

  // 角标：81029 | 红焦糖  / 款号：69322 | 颜色：兰棕
  const overlay: string[] = [];
  for (const part of text.split(/\s*\|\s*|\n+/)) {
    const p = part.trim();
    if (!p || /^\d{4,8}[A-Za-z]?$/.test(p)) continue;
    if (/^(SIN|MA|IN\s*MA)/i.test(p)) continue;
    const hits = countColorHits(p);
    for (const h of hits) {
      if (!overlay.includes(h)) overlay.push(h);
    }
    // 整段恰好是色名
    if (!hits.length && p.length <= 6 && /[\u4e00-\u9fff]/.test(p) && !/款号|成分|尺码|样品/.test(p)) {
      // 仅当在词典中
    }
  }
  if (overlay.length) return normalizeColorList(overlay);

  return normalizeColorList(countColorHits(text));
}

function normalizeColorList(colors: string[]): string[] {
  const out: string[] = [];
  for (let c of colors) {
    c = c.trim();
    if (!c) continue;
    // 归一短名
    if (c === '黑') c = '黑色';
    if (c === '白') c = '白色';
    if (c === '灰') c = '灰色';
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function extractStyleNo(text: string, filenames: string[]): string {
  const fields = parseBracketFields(text);
  if (fields['款号']) return fields['款号'].replace(/\s+/g, '');
  const m1 = text.match(/款号[：:\s]*([A-Za-z0-9\-_]{3,20})/i);
  if (m1) return m1[1];
  // 角标纯数字款号
  const m2 = text.match(/(?:^|\||\s)(\d{5,6})(?:A)?(?:\s|\||$)/);
  if (m2) return m2[1];
  for (const f of filenames) {
    const nm = path.basename(f, path.extname(f));
    const dig = nm.match(/\b(\d{4,8})\b/);
    if (dig) return dig[1];
  }
  return '';
}

function extractMaterial(text: string, fields: Record<string, string>): string {
  if (fields['成分'] || fields['材质']) return (fields['成分'] || fields['材质']).trim();
  const m = text.match(/(\d+%[^|\n]{0,40}(?:山羊绒|羊毛|桑蚕丝|腈纶|锦纶|聚酯纤维)[^|\n]{0,60})/);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  const m2 = text.match(/100%\s*山羊绒/);
  if (m2) return m2[0];
  // 质检纤维含量拼接
  const fibers = text.match(
    /(?:桑蚕丝|绵羊毛|腈纶|锦纶|聚酯纤维|山羊绒)\s*\d+(?:\.\d+)?%?/g,
  );
  if (fibers && fibers.length >= 2) return fibers.join(' ');
  return '';
}

function extractSizeText(text: string, fields: Record<string, string>): string {
  if (fields['尺码']) return fields['尺码'].trim();
  const m = text.match(/尺码[：:\s]*([0-9\s\-–]+(?:CM)?)/i);
  if (m) return m[1].trim();
  // 尺码表头 105CM 110CM ...
  const sizes = text.match(/1[0-3]0\s*CM/gi);
  if (sizes && sizes.length >= 3) {
    return [...new Set(sizes.map((s) => s.replace(/\s+/g, '').toUpperCase()))].join(' ');
  }
  return '';
}

async function assignRoles(
  assets: PublishBatchAsset[],
  ocrMap: Map<string, string>,
  metaMap: Map<string, { width?: number; height?: number }>,
): Promise<ImageSuggestion[]> {
  const suggestions: ImageSuggestion[] = assets.map((a) => {
    const ocr = ocrMap.get(a.mediaId) || '';
    const meta = { ...metaMap.get(a.mediaId), sizeBytes: a.sizeBytes };
    const fromOcr = guessRoleFromOcr(ocr, meta);
    const fromName = guessRoleFromFilename(a.filename);
    let role: ImageRole = 'unknown';
    let conf = 0.2;
    if (fromOcr && fromOcr.confidence >= fromName.confidence) {
      role = fromOcr.role;
      conf = fromOcr.confidence;
    } else {
      role = fromName.role;
      conf = fromName.confidence;
    }
    // 单色角标主图：写入 colorHint
    const colors = extractColorsFromText(ocr);
    const colorHint =
      role === 'main' && colors.length === 1
        ? colors[0]
        : role === 'multi_color'
          ? null
          : colors.length === 1
            ? colors[0]
            : null;

    return {
      mediaId: a.mediaId,
      url: a.url,
      filename: a.filename,
      role,
      roleConfidence: conf,
      colorHint,
      ocrText: ocr || undefined,
    };
  });

  // 无 hangtag：挑真正像吊牌/笔记字段的图（勿把多色挂拍抬成吊牌）
  if (!suggestions.some((s) => s.role === 'hangtag')) {
    let best: ImageSuggestion | null = null;
    let bestScore = 0;
    for (const s of suggestions) {
      if (s.role === 'multi_color') continue;
      const t = s.ocrText || '';
      let score = 0;
      if (/款号|成分|颜色|【/.test(t)) score += 50;
      if (/100%|山羊绒|羊毛|腈纶|锦纶/.test(t)) score += 20;
      score += Math.min(t.length, 80);
      if (isSizeChartText(t) || isLabReportText(t)) score -= 100;
      if (/SIN\s*MA/i.test(t) && !/颜色|成分/.test(t)) score -= 40;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best && bestScore >= 40 && /款号|成分|颜色|【/.test(best.ocrText || '')) {
      best.role = 'hangtag';
      best.roleConfidence = Math.max(best.roleConfidence, 0.55);
    }
  }

  // 横向大图尚未分类 → multi_color
  for (const s of suggestions) {
    if (s.role !== 'unknown') continue;
    const meta = metaMap.get(s.mediaId);
    const asset = assets.find((a) => a.mediaId === s.mediaId);
    if (
      meta?.width &&
      meta?.height &&
      meta.width > meta.height * 1.15 &&
      (asset?.sizeBytes || 0) > 250000 &&
      !isSizeChartText(s.ocrText || '') &&
      !isLabReportText(s.ocrText || '')
    ) {
      s.role = 'multi_color';
      s.roleConfidence = 0.5;
    }
  }

  // 尺码表/质检：显式入库，勿再抬成主图
  for (const s of suggestions) {
    if (s.role !== 'unknown') continue;
    if (isSizeChartText(s.ocrText || '')) {
      s.role = 'size_chart';
      s.roleConfidence = Math.max(s.roleConfidence, 0.7);
      continue;
    }
    if (isLabReportText(s.ocrText || '')) {
      s.role = 'lab_report';
      s.roleConfidence = Math.max(s.roleConfidence, 0.7);
      continue;
    }
  }
  // 剩余 unknown 保持未识别：禁止把生活照/无关图强行抬成 main/detail
  return suggestions;
}

export type StyleColorLookupFn = (
  styleNo: string,
) => Promise<StyleColorLookup | null | undefined>;

export async function buildPublishSuggestion(
  assets: PublishBatchAsset[],
  opts?: {
    runOcr?: boolean;
    /** 查已有商品 SKU 等；笔记回填内置，无需传入 */
    lookupByStyleNo?: StyleColorLookupFn;
    /** xytoken 多模态客户端；OCR 主路径 */
    vision?: VisionClient;
  },
): Promise<PublishSuggestion> {
  const runOcr = opts?.runOcr !== false;
  const ocrMap = new Map<string, string>();
  const metaMap = new Map<string, { width?: number; height?: number }>();
  let ocrUsed = false;
  let ocrNote = '未运行 OCR';

  // 元数据（尺寸）——用于分类
  await Promise.all(
    assets.map(async (a) => {
      const meta = await readImageMeta(a.localPath);
      metaMap.set(a.mediaId, meta);
    }),
  );

  // OCR 优先级：文件名像吊牌/多色 → 横向大图 → 其余；最多扫 12 张
  const order = [...assets].sort((a, b) => {
    const score = (x: PublishBatchAsset) => {
      const fn = guessRoleFromFilename(x.filename).role;
      if (fn === 'hangtag') return 0;
      if (fn === 'multi_color') return 1;
      const m = metaMap.get(x.mediaId);
      if (m?.width && m?.height && m.width > m.height * 1.1) return 2;
      return 3;
    };
    return score(a) - score(b);
  });

  if (runOcr) {
    const notes: string[] = [];
    const limit = Math.min(12, order.length);
    const concurrency = Math.max(
      1,
      Math.min(4, parseInt(process.env.VISION_OCR_CONCURRENCY || process.env.VISION_BATCH_SIZE || '3', 10) || 3),
    );
    const targets = order.slice(0, limit);
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const i = cursor++;
        const a = targets[i];
        try {
          const meta = metaMap.get(a.mediaId);
          const looksHang =
            guessRoleFromFilename(a.filename).role === 'multi_color' ||
            !!(
              a.sizeBytes > 200000 &&
              meta?.width &&
              meta?.height &&
              meta.width > meta.height * 1.05
            );
          const r = await tryOcr(a.localPath, {
            preferStrips: looksHang && macVisionOcrEnabled(),
            stripHint:
              meta?.width && meta?.height && meta.width > meta.height * 1.3 ? 16 : undefined,
            vision: opts?.vision,
          });
          if (r.used) ocrUsed = true;
          if (r.text) ocrMap.set(a.mediaId, r.text);
          notes.push(`${path.basename(a.filename)}: ${r.note}`);
        } catch (e: any) {
          notes.push(
            `${path.basename(a.filename)}: OCR 异常已跳过 ${String(e?.message || e).slice(0, 80)}`,
          );
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
    ocrNote = notes.slice(0, 3).join('；') || ocrNote;

    // 仅本机 Mac Vision 开启时，对颜色不足的多色图补跑分条
    if (macVisionOcrEnabled()) {
      for (const a of assets) {
        try {
          const text = ocrMap.get(a.mediaId) || '';
          const meta = metaMap.get(a.mediaId);
          const roleGuess = guessRoleFromOcr(text, { ...meta, sizeBytes: a.sizeBytes });
          const colors = extractColorsFromText(text);
          const textCore = text.replace(/SIN\s*MA/gi, '').replace(/[。．·•|/\s]/g, '');
          const onlyStyleNo = /^\d{5,6}[A-Za-z]?$/.test(textCore);
          const needStrips =
            colors.length < 2 &&
            (roleGuess?.role === 'multi_color' ||
              guessRoleFromFilename(a.filename).role === 'multi_color' ||
              onlyStyleNo ||
              (a.sizeBytes > 400000 && !isSizeChartText(text) && !isLabReportText(text)));
          if (needStrips) {
            let stripN: number | undefined;
            if (meta?.width && meta?.height) {
              const ar = meta.width / meta.height;
              if (ar >= 1.3) stripN = 16;
              else if (ar >= 1.05) stripN = 8;
              else stripN = 3;
            }
            const strips = await tryVisionStripOcr(a.localPath, stripN);
            if (strips?.text) {
              ocrMap.set(a.mediaId, [text, strips.text].filter(Boolean).join(' | '));
              ocrUsed = true;
              ocrNote = `${ocrNote}；补分条`;
            }
          }
        } catch {
          /* 分条失败不阻断 */
        }
      }
    }
  }

  const allText = [...ocrMap.values()].join('\n');
  const fields = parseBracketFields(allText);
  const images = await assignRoles(assets, ocrMap, metaMap);

  // 聚合颜色：吊牌字段 → 各图 OCR（含多色挂拍/角标）
  let colors: string[] = [];
  if (fields['颜色']) colors = splitColors(fields['颜色']);
  for (const img of images) {
    const fromImg = extractColorsFromText(img.ocrText || '');
    for (const c of fromImg) {
      if (!colors.includes(c)) colors.push(c);
    }
    if (img.colorHint && !colors.includes(img.colorHint)) colors.push(img.colorHint);
  }
  colors = normalizeColorList(colors);

  // 多色图角色：若 OCR 出了多个颜色，确保标记
  for (const img of images) {
    const cs = extractColorsFromText(img.ocrText || '');
    if (cs.length >= 2 && img.role !== 'hangtag') {
      img.role = 'multi_color';
      img.roleConfidence = Math.max(img.roleConfidence, 0.75);
      img.colorHint = null;
    }
  }

  // Vision 8 类 Taxonomy：有 VISION 时覆盖/补全启发式（任意一类命中即可）
  if (opts?.vision?.configured()) {
    try {
      const classified = await classifyPublishImageRoles(
        opts.vision,
        assets.map((a) => ({
          mediaId: a.mediaId,
          localPath: a.localPath,
          filename: a.filename,
        })),
      );
      for (const c of classified) {
        const img = images.find((i) => i.mediaId === c.mediaId);
        if (!img) continue;
        const role = normalizePublishImageRole(c.role) as ImageRole;
        // 置信度更高或原为 unknown 时采纳；吊牌/文档类优先采纳 vision
        const preferVision =
          img.role === 'unknown' ||
          c.confidence >= img.roleConfidence + 0.05 ||
          (c.role !== 'unknown' &&
            ['hangtag', 'size_chart', 'lab_report', 'on_model', 'packaging'].includes(c.role));
        if (preferVision) {
          img.role = role;
          img.roleConfidence = Math.max(img.roleConfidence, c.confidence);
        }
      }
      const hit = images.filter((i) => isRecognizedPublishImageRole(i.role)).length;
      analyzeLogger.log(
        `visionRoles hit=${hit}/${images.length} ` +
          images.map((i) => `${i.role}:${i.roleConfidence.toFixed(2)}`).join(','),
      );
    } catch (e: any) {
      analyzeLogger.warn(`visionRoles 跳过: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  // StyleNo 只从真实吊牌/标签 OCR 抽取——禁止文件名/临时号冒充
  const hangtagText = images
    .filter((i) => i.role === 'hangtag')
    .map((i) => i.ocrText || '')
    .filter(Boolean)
    .join('\n');
  let styleNo = '';
  if (hangtagText) {
    const hangFields = parseBracketFields(hangtagText);
    styleNo =
      extractStyleNo(hangtagText, []) || hangFields['款号'] || fields['款号'] || '';
  }
  styleNo = String(styleNo || '').trim().replace(/[A-Za-z]$/, '');
  if (styleNo && /^V\d{12}/i.test(styleNo)) styleNo = '';

  let material = extractMaterial(allText, fields);
  let styleName = fields['款式'] || '';
  let weight = fields['克重'] || '';
  let sizeText = extractSizeText(allText, fields);

  let colorSource: ColorSuggestionSource = 'ocr';
  let colorSourceNote = '';

  // 款号已识别且（颜色很少/占位，或少于笔记/SKU 列表）→ 回填并与 OCR/角标合并
  const ocrReal = colors.filter((c) => c && !/^色\d+$/.test(c));
  let lookup: StyleColorLookup | null = null;
  if (styleNo) {
    if (opts?.lookupByStyleNo) {
      try {
        lookup = (await opts.lookupByStyleNo(styleNo)) || null;
      } catch {
        lookup = null;
      }
    }
    const note = lookupColorsFromNotes(styleNo);
    if (!lookup?.colors?.length) {
      lookup = note;
    } else if (note) {
      if (!lookup.name && note.name) lookup.name = note.name;
      if (!lookup.material && note.material) lookup.material = note.material;
      if (!lookup.sizeText && note.sizeText) lookup.sizeText = note.sizeText;
      if (!lookup.weight && note.weight) lookup.weight = note.weight;
      // 笔记色更多时用笔记列表补全（商品 SKU 可能不全）
      if ((note.colors?.length || 0) > lookup.colors.length) {
        lookup = {
          ...lookup,
          colors: mergeColorsPreferOcr(lookup.colors, note.colors),
        };
      }
    }
  }

  const shouldBackfill =
    !!styleNo &&
    !!lookup?.colors?.length &&
    (isSparseColorList(colors) || ocrReal.length < lookup.colors.length);

  if (shouldBackfill && lookup) {
    colors = mergeColorsPreferOcr(ocrReal, lookup.colors);
    if (ocrReal.length) {
      colorSource = 'mixed';
      colorSourceNote = `OCR/角标 ${ocrReal.length} 色优先，+ ${lookup.source === 'product' ? '已有商品' : '微信笔记'}补全至 ${colors.length} 色（可编辑）`;
    } else {
      colorSource = lookup.source === 'product' ? 'product' : 'note';
      colorSourceNote = `由${colorSource === 'product' ? '已有商品 SKU' : '微信笔记'}按款号 ${styleNo} 回填 ${colors.length} 色（可编辑）`;
    }
    if (!styleName && lookup.name) styleName = lookup.name;
    if (!material && lookup.material) material = lookup.material;
    if (!sizeText && lookup.sizeText) sizeText = lookup.sizeText;
    if (!weight && lookup.weight) weight = lookup.weight;
    ocrNote = `${ocrNote}；${colorSourceNote}`;
  } else if (ocrReal.length) {
    colorSource = 'ocr';
  }

  if (!colors.length) {
    colors = assets.length >= 2 ? ['色1', '色2'] : ['色1'];
    colorSource = 'placeholder';
    colorSourceNote = '未识别到颜色，已占位（请编辑）';
  }

  const descParts: string[] = [];
  if (weight) descParts.push(`克重：${weight}`);
  if (colors.length && !colors[0].startsWith('色')) {
    descParts.push(`颜色：${colors.join('/')}`);
  }
  if (sizeText) descParts.push(`尺码：${sizeText}`);

  const skus: ColorSkuDraft[] = colors.map((color, idx) => {
    const mediaIds = images
      .filter(
        (im) =>
          im.colorHint === color ||
          (idx === 0 && im.role === 'main' && !im.colorHint),
      )
      .map((im) => im.mediaId);
    return { color, price: null, mediaIds };
  });

  const tags: string[] = [];
  if (weight) tags.push(weight);
  if (styleName) tags.push(...styleName.split(/\s+/).filter(Boolean).slice(0, 4));

  const result = {
    styleNo: String(styleNo || '').trim(),
    name: (styleName || (styleNo ? `款号 ${styleNo}` : '新款羊毛衫')).trim(),
    material: material.trim(),
    weight: weight.trim(),
    sizeText: sizeText.trim(),
    description: descParts.join('\n'),
    tags,
    colors,
    colorSource,
    colorSourceNote,
    images,
    skus,
    ocrUsed,
    ocrNote,
  };
  analyzeLogger.log(
    `suggestion ocr=${ocrUsed} styleNo=${result.styleNo || '-'} ` +
      `colors=${(colors || []).slice(0, 8).join('/') || '-'} ` +
      `name=${String(result.name).slice(0, 40)} note=${String(ocrNote || '').slice(0, 200)}`,
  );
  return result;
}
