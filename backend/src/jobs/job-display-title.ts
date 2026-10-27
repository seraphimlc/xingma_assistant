import { findTemplate, MODELS } from '../promo/promo.templates';
import { isProvisionalStyleNo } from '../vision/publish-vision';

/** 任务列表友好标题：一眼看出场景/模特或发品款号，避免写死「宣传生图」 */
export function buildJobDisplayTitle(
  type: string,
  payload: Record<string, unknown> | null | undefined,
): string {
  const p = (payload || {}) as Record<string, any>;
  const templateId = String(p.templateId || '').trim();
  // promo_image 一律按当前 modelId/scenes 现算，避免缓存「女模特」与实选男模不一致
  if (type === 'promo_image') return buildPromoTitle(p);

  const cached = String(p.displayTitle || '').trim();
  if (cached && templateId !== 'multi_color') return cached;

  if (type === 'promo_video') {
    const styleNo = String(p.styleNo || '').trim();
    const tpl = findTemplate(String(p.templateId || ''));
    const name = tpl?.name || '宣传视频';
    return styleNo ? `${name} · 款号${styleNo}` : name;
  }
  if (type === 'publish_product') return buildPublishTitle(p);
  if (type === 'cover_reselect') {
    const styleNo = String(p.styleNo || '').trim();
    return styleNo ? `重选封面 · 款号${styleNo}` : '重选封面';
  }
  return type || '任务';
}

function modelWho(modelId?: string | null): string | null {
  if (!modelId) return null;
  const id = String(modelId).trim();
  if (!id) return null;
  const m = MODELS.find((x) => x.id === id);
  // 优先按 MODELS 配置的性别（name 含 女/男），与实选模特一致
  if (m) {
    if (/女/.test(m.name) || id.startsWith('f_')) return '女模特';
    if (/男/.test(m.name) || id.startsWith('m_')) return '男模特';
    return m.name;
  }
  if (id.startsWith('m_')) return '男模特';
  if (id.startsWith('f_')) return '女模特';
  return null;
}

function buildMultiColorTitle(p: Record<string, any>): string {
  const styleNo = String(p.styleNo || '').trim();
  const colors = Array.isArray(p.colors) ? p.colors.map((c: any) => String(c || '').trim()).filter(Boolean) : [];
  const colorPart = colors.length ? `${colors.length}色` : '';
  if (styleNo && colorPart) return `多色展示 · 款号${styleNo} · ${colorPart}`;
  if (styleNo) return `多色展示 · 款号${styleNo}`;
  if (colorPart) return `多色展示 · ${colorPart}`;
  return '多色展示';
}

function buildPromoTitle(p: Record<string, any>): string {
  const templateId = String(p.templateId || '');
  if (templateId === 'multi_color') return buildMultiColorTitle(p);

  const tpl = findTemplate(templateId);
  const sceneIds: string[] = Array.isArray(p.scenes) ? p.scenes : [];
  const scenes = (tpl?.scenes || []).filter((s) => sceneIds.includes(s.id));
  const sceneName = scenes[0]?.name || '';
  const who = modelWho(p.modelId);
  if (sceneName && who) {
    const join = /里$/.test(sceneName) ? '的' : '里的';
    return `${sceneName}${join}${who}`;
  }
  if (sceneName) return sceneName;
  if (who) return who;
  if (tpl?.name) return tpl.name;
  return '宣传生图';
}

function buildPublishTitle(p: Record<string, any>): string {
  // 未识别：禁止展示临时号/「识别中」「草稿」
  if (p.recognized === false || p.outcome === '未识别出商品') {
    return '选图发品 · 未识别出商品';
  }
  const styleNo = String(p.styleNo || p.draftStyleNo || '').trim();
  if (styleNo && !isProvisionalStyleNo(styleNo)) {
    return `选图发品 · 款号${styleNo}`;
  }
  // 临时号等同未识别（不得冒充正式款号）
  if (styleNo && isProvisionalStyleNo(styleNo)) {
    return '选图发品 · 未识别出商品';
  }
  return '选图发品';
}
