/**
 * 选图发品图类型（锁定 8 类；其余 = unknown / 未识别）。
 * 成功判定：批次中命中任意一类即可，不要求齐全。
 * StyleNo 仅来自 hangtag OCR，禁止临时 V 号冒充。
 */
export type ImageRole =
  | 'main' // 1 挂拍图（含平铺）
  | 'detail' // 2 细节图（面料/工艺特写）
  | 'hangtag' // 3 商品吊牌/标签（含水洗标）
  | 'size_chart' // 4 尺码表
  | 'lab_report' // 5 检测/合规报告
  | 'on_model' // 6 上身效果图（真人/模特）
  | 'packaging' // 7 包装/袋装展示
  | 'multi_color' // 8 色卡/多色对照
  | 'unknown'; // 不在枚举内 → 识别失败候选

/** 正式枚举（不含 unknown） */
export const PUBLISH_IMAGE_ROLES: ReadonlyArray<Exclude<ImageRole, 'unknown'>> = [
  'main',
  'detail',
  'hangtag',
  'size_chart',
  'lab_report',
  'on_model',
  'packaging',
  'multi_color',
] as const;

export const PUBLISH_IMAGE_ROLE_LABELS: Record<ImageRole, string> = {
  main: '挂拍图（含平铺）',
  detail: '细节图（面料/工艺特写）',
  hangtag: '商品吊牌/标签（含水洗标）',
  size_chart: '尺码表',
  lab_report: '检测/合规报告',
  on_model: '上身效果图（真人/模特）',
  packaging: '包装/袋装展示',
  multi_color: '色卡/多色对照',
  unknown: '未识别',
};

export function isRecognizedPublishImageRole(
  role: string | null | undefined,
): role is Exclude<ImageRole, 'unknown'> {
  return (PUBLISH_IMAGE_ROLES as readonly string[]).includes(String(role || ''));
}

export interface PublishBatchAsset {
  mediaId: string;
  objectKey: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
}

export interface PublishBatch {
  batchId: string;
  tenantId: string;
  createdAt: number;
  assets: PublishBatchAsset[];
  suggestion?: PublishSuggestion;
}

export interface ImageSuggestion {
  mediaId: string;
  url: string;
  filename: string;
  role: ImageRole;
  roleConfidence: number;
  /** 建议归属颜色名（可空） */
  colorHint: string | null;
  ocrText?: string;
}

export interface ColorSkuDraft {
  color: string;
  price: string | null;
  /** 该色建议挂的图 mediaId */
  mediaIds: string[];
}

export type ColorSuggestionSource = 'ocr' | 'note' | 'product' | 'mixed' | 'vision' | 'placeholder';

export type TitleSuggestionSource = 'hangtag' | 'input' | 'vision' | 'fallback' | 'styleNo';

export interface PublishSuggestion {
  styleNo: string;
  name: string;
  /** 可选副标题（vision 生成时可能有） */
  subtitle?: string;
  material: string;
  weight: string;
  sizeText: string;
  description: string;
  tags: string[];
  colors: string[];
  /** 颜色列表主要来源：ocr / note / product / mixed / vision / placeholder */
  colorSource?: ColorSuggestionSource;
  /** 回填说明，便于 UI 提示可编辑 */
  colorSourceNote?: string;
  /** 标题来源 */
  titleSource?: TitleSuggestionSource;
  images: ImageSuggestion[];
  skus: ColorSkuDraft[];
  ocrUsed: boolean;
  ocrNote: string;
  levelIdHint?: string;
  /** 异步建品时：占位色/临时款号等需人工复核 */
  needReview?: boolean;
  reviewReasons?: string[];
}

export interface ConfirmPublishInput {
  batchId: string;
  styleNo: string;
  name: string;
  material?: string | null;
  description?: string | null;
  levelId: string;
  groupId?: string | null;
  priceDisplay?: 'show' | 'hide';
  status?: 'on_sale' | 'off_sale' | 'draft';
  tags?: string[];
  /** 颜色 SKU：一色一行，仅 color + price */
  skus: Array<{ color: string; price?: string | null }>;
  /** 图角色与归属（用户可改） */
  images: Array<{
    mediaId: string;
    role: ImageRole;
    colorHint?: string | null;
  }>;
  /** cover 顺序；默认 主图→细节→场景→文字类，封面置顶 */
  coverMediaIds?: string[];
}
