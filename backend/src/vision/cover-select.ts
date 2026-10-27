import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { VisionClient } from './vision.client';

export interface CoverCandidate {
  id: string;
  localPath: string;
  filename?: string;
  roleHint?: string;
}

export interface CoverSelectResult {
  coverId: string;
  orderedIds: string[];
  via: 'vision' | 'heuristic';
  reason: string;
  rejected?: Array<{ id: string; type: string }>;
}

const BAD_NAME =
  /尺码|尺寸表|size.?chart|质检|检验报告|lab.?report|test.?report|吊牌|标签|hangtag|coupon|优惠券|细则/i;
const GOOD_NAME = /主图|封面|main|cover|平铺|挂拍|全身|半身/i;

const logger = new Logger('CoverSelect');

/** 文档/报表启发式：高白底 + 低色彩（质检报告/尺码表常见） */
export function looksLikeDocument(localPath: string): boolean {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const script = `
from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGB').resize((64,64))
px=list(im.getdata())
n=len(px)
white=sum(1 for r,g,b in px if r>210 and g>210 and b>210)/n
# 色彩饱和度均值
def sat(r,g,b):
  mx,mn=max(r,g,b),min(r,g,b)
  return 0 if mx==0 else (mx-mn)/mx
s=sum(sat(r,g,b) for r,g,b in px)/n
print(f'{white:.4f} {s:.4f}')
`;
    const out = execFileSync('python3', ['-c', script, localPath], { encoding: 'utf8' }).trim();
    const [w, s] = out.split(/\s+/).map(Number);
    return w > 0.55 && s < 0.18;
  } catch {
    return false;
  }
}

export function heuristicPickCover(cands: CoverCandidate[]): CoverSelectResult {
  const scored = cands.map((c, i) => {
    const name = c.filename || path.basename(c.localPath || '');
    let score = 40 - Math.min(i, 20);
    const role = (c.roleHint || '').toLowerCase();
    if (role === 'main') score += 40;
    else if (role === 'multi_color') score += 25;
    else if (role === 'detail') score -= 25;
    else if (role === 'hangtag' || role === 'size_chart' || role === 'lab_report') score -= 60;
    else if (role === 'packaging') score -= 40;
    else if (role === 'on_model' || role === 'scene' || role === 'model') score -= 35;
    if (BAD_NAME.test(name)) score -= 80;
    if (/场景|模特|上身|街拍|lookbook|scene|\bmodel\b/i.test(name)) score -= 40;
    if (GOOD_NAME.test(name) && !/场景|模特|上身|街拍|lookbook|scene|\bmodel\b/i.test(name)) score += 30;
    if (/promo\//i.test(c.localPath || '') || /\/promo\//i.test(name)) score -= 200;
    if (c.localPath && fs.existsSync(c.localPath) && looksLikeDocument(c.localPath)) score -= 100;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const pick = scored[0]?.c;
  if (!pick) throw new Error('无候选图');
  return {
    coverId: pick.id,
    orderedIds: scored.map((s) => s.c.id),
    via: 'heuristic',
    reason: `启发式 score=${scored[0].score}`,
  };
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

async function visionPickOne(
  vision: VisionClient,
  pool: CoverCandidate[],
): Promise<{ bestIndex: number; type: string; reason: string; reject: Array<{ index: number; type: string }> }> {
  const parts: Parameters<VisionClient['chat']>[0] = [
    {
      type: 'text',
      text: `你是羊毛衫电商选图助手。共 ${pool.length} 张图（index 0..${pool.length - 1}）。
选出最适合做「列表首图/封面」的一张。
必须排除：尺码表、质检/检验报告、吊牌文字、纯文字、优惠券、过近局部、单据二维码。
优先：全身/半身挂拍、平铺主图、一眼看清衣服。
只回一行 JSON：{"best_index":0,"type":"main|multi_color|detail|on_model|packaging|size_chart|lab_report|hangtag|other","reason":"一句话","reject":[{"index":1,"type":"lab_report"}]}`,
    },
  ];
  for (let i = 0; i < pool.length; i++) {
    parts.push({
      type: 'text',
      text: `index=${i} file=${pool[i].filename || path.basename(pool[i].localPath)}`,
    });
    parts.push({
      type: 'image_url',
      image_url: { url: vision.fileToDataUrl(pool[i].localPath) },
    });
  }
  const content = await vision.chat(parts, { maxTokens: 400 });
  const parsed = parseJsonLoose(content);
  let idx = Number(parsed.best_index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) {
    throw new Error(`非法 best_index: ${parsed.best_index}`);
  }
  const badTypes = new Set(['size_chart', 'lab_report', 'hangtag', 'coupon', 'text']);
  if (badTypes.has(String(parsed.type || ''))) {
    const rejectedIdx = new Set((parsed.reject || []).map((r: any) => Number(r.index)));
    rejectedIdx.add(idx);
    const alt = pool.findIndex((_, i) => !rejectedIdx.has(i));
    if (alt >= 0) idx = alt;
  }
  return {
    bestIndex: idx,
    type: String(parsed.type || 'other'),
    reason: String(parsed.reason || ''),
    reject: (parsed.reject || [])
      .filter((r: any) => Number.isInteger(r.index))
      .map((r: any) => ({ index: Number(r.index), type: String(r.type || 'other') })),
  };
}

/**
 * 多模态选封面。策略：先文档启发式剔除 → 分组淘汰赛（每组≤4）→ 失败整降级启发式。
 */
export async function selectCoverImage(
  vision: VisionClient,
  cands: CoverCandidate[],
): Promise<CoverSelectResult> {
  if (!cands.length) throw new Error('无候选图');

  // 预筛：文件名/角色/文档外观
  const pre = cands.filter((c) => {
    const name = c.filename || path.basename(c.localPath || '');
    const role = (c.roleHint || '').toLowerCase();
    if (/\/promo\//i.test(c.localPath || '') || /\/promo\//i.test(name)) return false;
    if (role === 'hangtag' || role === 'size_chart' || role === 'lab_report' || role === 'packaging' || role === 'on_model' || role === 'scene' || role === 'model') return false;
    if (BAD_NAME.test(name) && !GOOD_NAME.test(name)) return false;
    if (/场景|模特|上身|街拍|lookbook|\bmodel\b/i.test(name) && !/挂拍|平铺|主图/i.test(name)) return false;
    if (c.localPath && fs.existsSync(c.localPath) && looksLikeDocument(c.localPath)) return false;
    return true;
  });
  let pool = pre.length ? pre : cands;
  // 仍可能全被筛掉时退回全量但标记
  if (!pre.length) {
    logger.warn('预筛后无候选，使用全量+启发式兜底');
  }

  if (!vision.configured()) {
    const h = heuristicPickCover(pool.length ? pool : cands);
    return { ...h, reason: '未配置 VISION_API_KEY，启发式' };
  }

  try {
    const batchSize = Math.max(2, Math.min(4, parseInt(process.env.VISION_BATCH_SIZE || '4', 10)));
    let contenders = pool.slice(0, Math.max(batchSize, parseInt(process.env.VISION_MAX_CANDIDATES || '12', 10)));
    const allRejected: Array<{ id: string; type: string }> = [];

    // 淘汰赛：每轮把 contenders 按 batch 分组，每组胜出晋级
    while (contenders.length > 1) {
      if (contenders.length <= batchSize) {
        const picked = await visionPickOne(vision, contenders);
        for (const r of picked.reject) {
          if (r.index >= 0 && r.index < contenders.length) {
            allRejected.push({ id: contenders[r.index].id, type: r.type });
          }
        }
        const winner = contenders[picked.bestIndex];
        const rest = cands.map((c) => c.id).filter((id) => id !== winner.id);
        return {
          coverId: winner.id,
          orderedIds: [winner.id, ...rest],
          via: 'vision',
          reason: picked.reason || picked.type,
          rejected: allRejected,
        };
      }
      const next: CoverCandidate[] = [];
      for (let i = 0; i < contenders.length; i += batchSize) {
        const group = contenders.slice(i, i + batchSize);
        if (group.length === 1) {
          next.push(group[0]);
          continue;
        }
        const picked = await visionPickOne(vision, group);
        for (const r of picked.reject) {
          if (r.index >= 0 && r.index < group.length) {
            allRejected.push({ id: group[r.index].id, type: r.type });
          }
        }
        next.push(group[picked.bestIndex]);
      }
      contenders = next;
    }

    const winner = contenders[0];
    return {
      coverId: winner.id,
      orderedIds: [winner.id, ...cands.map((c) => c.id).filter((id) => id !== winner.id)],
      via: 'vision',
      reason: 'tournament',
      rejected: allRejected,
    };
  } catch (e: any) {
    logger.warn(`vision 选封面失败，降级启发式: ${String(e?.message || e).slice(0, 160)}`);
    const h = heuristicPickCover(pool.length ? pool : cands);
    return { ...h, reason: `vision失败→启发式: ${String(e?.message || e).slice(0, 80)}` };
  }
}

export function reorderCoverIds(allIds: string[], coverId: string): string[] {
  if (!coverId || !allIds.includes(coverId)) return [...allIds];
  return [coverId, ...allIds.filter((id) => id !== coverId)];
}

/** 展示序候选：角色 / 文件名 / 视觉文档启发式 */
export interface DisplayOrderItem {
  id: string;
  roleHint?: string;
  filename?: string;
  localPath?: string;
  typeHint?: string;
}

const SCENE_NAME = /场景|模特|上身|街拍|lookbook|scene|\bmodel\b/i;
const MAIN_ONLY_NAME = /主图|封面|main|cover|平铺|挂拍|全身|半身/i;
const DOC_TYPES = new Set(['size_chart', 'lab_report', 'hangtag', 'coupon', 'text', 'document']);

/**
 * 默认展示桶：0 挂拍/主图 → 1 细节 → 2 场景/模特 → 3 尺码表/质检/吊牌等文字类
 * （吊牌 hangtag 属文字类，排最后；multi_color 与主图同级）
 */
export function displayOrderBucket(item: DisplayOrderItem): number {
  const role = (item.roleHint || '').toLowerCase();
  const type = (item.typeHint || '').toLowerCase();
  const name = item.filename || (item.localPath ? path.basename(item.localPath) : '');

  if (DOC_TYPES.has(role) || DOC_TYPES.has(type) || role === 'hangtag' || role === 'size_chart' || role === 'lab_report' || role === 'packaging') return 3;
  if (BAD_NAME.test(name) && !MAIN_ONLY_NAME.test(name)) return 3;
  if (item.localPath && fs.existsSync(item.localPath) && looksLikeDocument(item.localPath)) return 3;

  if (role === 'detail' || type === 'detail') return 1;
  if (role === 'on_model' || role === 'scene' || role === 'model' || type === 'scene' || type === 'model' || type === 'on_model') return 2;
  if (SCENE_NAME.test(name)) return 2;

  if (role === 'main' || role === 'multi_color' || type === 'main' || type === 'multi_color') return 0;
  if (MAIN_ONLY_NAME.test(name)) return 0;
  return 0;
}

/** 按展示规则排序 mediaId（稳定：同桶保持原相对序） */
export function sortMediaIdsByDisplayOrder(items: DisplayOrderItem[]): string[] {
  const scored = items.map((it, i) => ({ id: it.id, bucket: displayOrderBucket(it), i }));
  scored.sort((a, b) => a.bucket - b.bucket || a.i - b.i);
  return scored.map((s) => s.id);
}

/** 先按展示规则排序；仅当封面属于挂拍/主图桶时才置顶，避免细节/模特被误选后霸占首图 */
export function orderCoverMediaIds(items: DisplayOrderItem[], coverId: string): string[] {
  const sorted = sortMediaIdsByDisplayOrder(items);
  const cover = items.find((it) => it.id === coverId);
  if (!cover) return sorted;
  if (displayOrderBucket(cover) === 0) return reorderCoverIds(sorted, coverId);
  // 封面是细节/场景/文档时：保持展示序（主图在前），不强制置顶误选封面
  return sorted;
}
