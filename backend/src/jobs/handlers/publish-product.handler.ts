import { Logger } from '@nestjs/common';
import { JobsService } from '../jobs.service';
import { JobHandler, JobRecord } from '../job.types';
import { PublishService } from '../../products/publish/publish.service';
import { VisionClient } from '../../vision/vision.client';
import { orderCoverMediaIds, selectCoverImage } from '../../vision/cover-select';
import {
  generateProductTitle,
  estimateGarmentColors,
  isWeakProductTitle,
  isPlaceholderColorList,
  isProvisionalStyleNo,
} from '../../vision/publish-vision';
import { AuthContext } from '../../common/interfaces/auth-context.interface';
import {
  ColorSuggestionSource,
  PublishSuggestion,
  TitleSuggestionSource,
  isRecognizedPublishImageRole,
  PUBLISH_IMAGE_ROLE_LABELS,
} from '../../products/publish/publish.types';

const logger = new Logger('PublishJob');

const REASON_ZH: Record<string, string> = {
  no_product_material: '不是商品资料图',
  not_garment_material: '图片不是服装类资料',
  missing_style_no: '未识别到吊牌款号',
  hangtag_unclear: '吊牌文字不清晰',
  ocr_timeout: '吊牌 OCR 超时',
  weak_title: '无法确认商品名称',
  color_placeholder: '未识别到颜色',
  title_fallback: '标题不可靠',
  empty_title_filled: '标题为空',
  style_no_conflict: '款号与已有商品冲突',
};

function humanPublishFailureReason(opts: {
  subtitle?: string | null;
  ocrNote?: string | null;
  reviewReasons?: string[];
  explicit?: string | null;
}): string {
  const explicit = String(opts.explicit || '').trim();
  if (explicit) return explicit.length <= 60 ? explicit : explicit.slice(0, 60);
  const sub = String(opts.subtitle || '').trim();
  const note = String(opts.ocrNote || '').trim();
  const blob = `${sub} ${note}`;
  if (/不是商品资料|非商品资料|无关图片|生活照|不是资料图/.test(blob)) {
    return '不是商品资料图';
  }
  if (/不是服装|非服装|不成衣|非成衣|不是衣服|非针织|非毛衫|非服装类资料/.test(blob)) {
    return '图片不是服装类资料';
  }
  if (/OCR 超时|aborted|AbortError|ETIMEDOUT/i.test(blob)) {
    return '吊牌 OCR 超时';
  }
  if (/吊牌.*(不清|模糊|无法|看不清)|看不清.*吊牌|无吊牌/.test(blob)) {
    return '吊牌文字不清晰';
  }
  if (sub && /(未清晰|无法|不是|不能|失败|无吊牌|看不清)/.test(sub)) {
    return sub.length <= 60 ? sub : sub.slice(0, 60);
  }
  const reasons = opts.reviewReasons || [];
  const mapped = reasons.map((r) => REASON_ZH[r] || r).filter(Boolean);
  if (mapped.length) return mapped.join('；');
  if (note) return note.length <= 60 ? note : note.slice(0, 60);
  return '未识别出商品';
}


export function registerPublishProductHandler(
  jobs: JobsService,
  publish: PublishService,
  vision: VisionClient,
) {
  const handle: JobHandler = async (job, ctx) => {
    const batchId = String(job.input.batchId || '');
    const productId = String(job.input.productId || '');
    if (!batchId) throw new Error('缺少 batchId');
    if (!productId) throw new Error('缺少 productId（请走 enqueue 先建草稿）');
    const user = jobUser(job);
    const statusIntent = String(job.input.statusIntent || job.input.status || 'on_sale');

    logger.log(
      `start jobId=${job.id} productId=${productId} batchId=${batchId} statusIntent=${statusIntent}`,
    );
    await ctx.updateProgress({ percent: 5, step: 'analyze', message: '分析图片中' });

    const analyzeStarted = Date.now();
    const analyzed = await publish.analyze(user, batchId, { runOcr: true });
    const suggestion = analyzed.suggestion as PublishSuggestion;
    const analyzeMs = Date.now() - analyzeStarted;
    logger.log(
      `analyze jobId=${job.id} productId=${productId} ms=${analyzeMs} ` +
        `ocr=${suggestion.ocrUsed} styleNo=${suggestion.styleNo || '-'} ` +
        `colors=${(suggestion.colors || []).slice(0, 8).join('/') || '-'} ` +
        `roles=${(suggestion.images || []).map((i) => i.role).join('/') || '-'} ` +
        `note=${String(suggestion.ocrNote || '').slice(0, 200)}`,
    );

    const batch = publish.getBatch(user.tenantId, batchId);
    const sourceMediaIds = batch.assets.map((a) => a.mediaId);
    const sourceImages = batch.assets.map((a) => {
      const im = suggestion.images?.find((i) => i.mediaId === a.mediaId);
      return {
        mediaId: a.mediaId,
        url: a.url || '',
        filename: a.filename || '',
        role: im?.role || 'unknown',
      };
    });

    // 锁定规则：批次命中任意 1/8 类即可；全部 unknown → 同样转待补全（图保留，人工核对）
    const recognizedImages = (suggestion.images || []).filter((i) =>
      isRecognizedPublishImageRole(i.role),
    );
    if (!recognizedImages.length) {
      const reasons = ['no_product_material'];
      const blob = `${suggestion.ocrNote || ''} ${(suggestion.images || [])
        .map((i) => i.ocrText || '')
        .join(' ')}`;
      const failZh = /自拍|风景|餐饮|聊天|截图|宠物|非服装|不是衣服/.test(blob)
        ? REASON_ZH.not_garment_material
        : REASON_ZH.no_product_material;
      const levelId = String(
        job.input.levelId || process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open',
      );
      const product = await publish.markPendingCompletion(user, {
        batchId,
        productId,
        name: String(job.input.name || '').trim() || '待补信息',
        material: suggestion.material || null,
        description: null,
        levelId,
        priceDisplay: (job.input.priceDisplay as any) || 'show',
        reviewReasons: reasons,
        failureReason: failZh,
      });
      logger.log(
        `pendingCompletion(taxonomy) jobId=${job.id} productId=${productId} reason=${failZh}`,
      );
      return {
        recognized: false,
        pendingCompletion: true,
        outcome: '待补全信息',
        failureReason: failZh,
        productId: (product as any)?.id || productId,
        styleNo: null,
        draftStyleNo: String(job.input.draftStyleNo || '').trim() || null,
        name: (product as any)?.name || null,
        subtitle: suggestion.subtitle || null,
        skuCount: 0,
        styleNoProvisional: true,
        needReview: true,
        reviewReasons: reasons,
        status: 'off_sale',
        highComplete: false,
        sourceMediaIds,
        sourceImages,
      };
    }
    logger.log(
      `taxonomy jobId=${job.id} hit=${recognizedImages.length}/${(suggestion.images || []).length} ` +
        `types=${[...new Set(recognizedImages.map((i) => PUBLISH_IMAGE_ROLE_LABELS[i.role] || i.role))].join('、')}`,
    );

    await ctx.updateProgress({ percent: 35, step: 'cover', message: '多模态选封面' });

    const cands = batch.assets.map((a) => {
      const img = suggestion?.images?.find((i) => i.mediaId === a.mediaId);
      return {
        id: a.mediaId,
        localPath: a.localPath,
        filename: a.filename,
        roleHint: img?.role,
        url: a.url,
      };
    });
    const cover = await selectCoverImage(vision, cands);
    logger.log(
      `cover jobId=${job.id} productId=${productId} via=${cover.via} coverId=${cover.coverId} reason=${cover.reason}`,
    );

    const reviewReasons: string[] = [];
    let needReview = false;

    const hasHangtag = (suggestion.images || []).some((i) => i.role === 'hangtag');
    const ocrStyleNo = String(suggestion.styleNo || '').trim();
    const hangtagNameClear =
      hasHangtag && !isWeakProductTitle(suggestion.name) && !String(job.input.name || '').trim();
    // 规则：吊牌/OCR 有清晰品名 → 用之；否则（含无吊牌）用商品图 Vision 生成，禁止文件名/「款号 xxx」占位当最终名
    const needVisionTitle =
      !String(job.input.name || '').trim() &&
      !hangtagNameClear &&
      isWeakProductTitle(suggestion.name);

    let titleSource: TitleSuggestionSource =
      String(job.input.name || '').trim()
        ? 'input'
        : hangtagNameClear
          ? 'hangtag'
          : 'fallback';
    let name = String(job.input.name || suggestion.name || '').trim();
    let subtitle = String(suggestion.subtitle || '').trim() || undefined;

    if (needVisionTitle) {
      await ctx.updateProgress({ percent: 50, step: 'title', message: 'Vision 生成标题' });
      const coverAsset = batch.assets.find((a) => a.mediaId === cover.coverId);
      const titlePaths: string[] = [];
      const titleUrls: string[] = [];
      const pushTitle = (a?: { localPath?: string; url?: string } | null) => {
        if (a?.localPath && !titlePaths.includes(a.localPath)) {
          titlePaths.push(a.localPath);
          titleUrls.push(a.url || '');
        }
      };
      pushTitle(coverAsset);
      for (const a of batch.assets) {
        const im = suggestion.images?.find((i) => i.mediaId === a.mediaId);
        if (im && (im.role === 'hangtag' || im.role === 'size_chart' || im.role === 'lab_report' || im.role === 'packaging')) continue;
        pushTitle(a);
      }
      if (!titlePaths.length) pushTitle(batch.assets[0]);
      const gen = await generateProductTitle(vision, titlePaths.slice(0, 4), {
        styleNo: ocrStyleNo || undefined,
        urls: titleUrls.slice(0, 4),
      });
      name = gen.title;
      if (gen.subtitle) subtitle = gen.subtitle;
      titleSource = gen.via === 'vision' ? 'vision' : 'fallback';
      logger.log(
        `title jobId=${job.id} productId=${productId} via=${gen.via} name=${name} ` +
          `hasHangtag=${hasHangtag} paths=${titlePaths.length} reason=${gen.reason}`,
      );
      if (gen.via !== 'vision') {
        reviewReasons.push('title_fallback');
        needReview = true;
      }
    } else if (!name || isWeakProductTitle(name)) {
      name = ocrStyleNo ? `款号 ${ocrStyleNo}` : '针织上衣';
      titleSource = ocrStyleNo ? 'styleNo' : 'fallback';
      needReview = true;
      reviewReasons.push('empty_title_filled');
      logger.log(`title jobId=${job.id} productId=${productId} via=${titleSource} name=${name}`);
    } else {
      logger.log(
        `title jobId=${job.id} productId=${productId} via=${titleSource} name=${name} hasHangtag=${hasHangtag}`,
      );
    }

    let colors = [...(suggestion.colors || [])];
    let colorSource: ColorSuggestionSource = suggestion.colorSource || 'ocr';
    let colorSourceNote = suggestion.colorSourceNote || '';

    if (isPlaceholderColorList(colors) || colorSource === 'placeholder') {
      await ctx.updateProgress({ percent: 58, step: 'colors', message: 'Vision 估色' });
      const colorPaths: string[] = [];
      const colorUrls: string[] = [];
      const preferRoles = new Set(['multi_color', 'main', 'on_model']);
      for (const a of batch.assets) {
        const im = suggestion.images?.find((i) => i.mediaId === a.mediaId);
        if (im && preferRoles.has(im.role)) {
          colorPaths.push(a.localPath);
          colorUrls.push(a.url || '');
        }
      }
      const coverAssetForColor = batch.assets.find((a) => a.mediaId === cover.coverId);
      if (coverAssetForColor?.localPath && !colorPaths.includes(coverAssetForColor.localPath)) {
        colorPaths.unshift(coverAssetForColor.localPath);
        colorUrls.unshift(coverAssetForColor.url || '');
      }
      if (!colorPaths.length) {
        for (const a of batch.assets.slice(0, 3)) {
          colorPaths.push(a.localPath);
          colorUrls.push(a.url || '');
        }
      }
      const est = await estimateGarmentColors(vision, colorPaths, colorUrls);
      if (est.colors.length) {
        colors = est.colors;
        colorSource = 'vision';
        colorSourceNote = est.reason;
        logger.log(
          `colors jobId=${job.id} productId=${productId} via=vision ${colors.join('/')}`,
        );
      } else {
        colors = batch.assets.length >= 2 ? ['色1', '色2'] : ['色1'];
        colorSource = 'placeholder';
        colorSourceNote = est.reason || '未识别到颜色，已占位（请编辑）';
        needReview = true;
        reviewReasons.push('color_placeholder');
        logger.log(
          `colors jobId=${job.id} productId=${productId} via=placeholder ${colorSourceNote}`,
        );
      }
    } else {
      logger.log(
        `colors jobId=${job.id} productId=${productId} via=${colorSource} ${colors.slice(0, 8).join('/')}`,
      );
    }

    await ctx.updateProgress({
      percent: 72,
      step: 'confirm',
      message: `封面已选(${cover.via})，整理结果`,
    });

    // OCR/分析款号优先；其次用户入队指定。禁止再生成临时款号冒充正式款号。
    let styleNo = String(suggestion.styleNo || '').trim();
    if (!styleNo) styleNo = String(job.input.styleNo || '').trim();
    // 入队占位 V 号不算识别成功
    if (styleNo && isProvisionalStyleNo(styleNo)) styleNo = '';
    const draftStyleNo = String(job.input.draftStyleNo || '').trim();
    let styleNoProvisional = false;
    if (!styleNo) {
      styleNoProvisional = true;
      needReview = true;
      if (!reviewReasons.includes('missing_style_no')) reviewReasons.push('missing_style_no');
      logger.log(`no real styleNo jobId=${job.id} productId=${productId} draft=${draftStyleNo || '-'}`);
    }

    const descParts: string[] = [];
    if (suggestion.description) descParts.push(suggestion.description);
    if (subtitle && !(suggestion.description || '').includes(subtitle)) {
      descParts.push(subtitle);
    }
    if (colors.length && !colors[0].startsWith('色') && !(suggestion.description || '').includes('颜色：')) {
      descParts.push(`颜色：${colors.join('/')}`);
    }
    suggestion.name = name;
    suggestion.subtitle = subtitle;
    suggestion.titleSource = titleSource;
    suggestion.colors = colors;
    suggestion.colorSource = colorSource;
    suggestion.colorSourceNote = colorSourceNote;
    suggestion.styleNo = styleNo;
    suggestion.description = descParts.filter(Boolean).join('\n');
    suggestion.skus = colors.map((color, idx) => {
      const mediaIds = (suggestion.images || [])
        .filter(
          (im) =>
            im.colorHint === color ||
            (idx === 0 && im.role === 'main' && !im.colorHint),
        )
        .map((im) => im.mediaId);
      return { color, price: null as string | null, mediaIds };
    });

    const images = (suggestion.images || []).map((im) => ({
      mediaId: im.mediaId,
      role: im.role,
      colorHint: im.colorHint,
    }));
    for (const a of batch.assets) {
      if (!images.find((i) => i.mediaId === a.mediaId)) {
        images.push({ mediaId: a.mediaId, role: 'unknown' as const, colorHint: null });
      }
    }

    const coverMediaIds = orderCoverMediaIds(
      images.map((im) => {
        const a = batch.assets.find((x) => x.mediaId === im.mediaId);
        return {
          id: im.mediaId,
          roleHint: im.role,
          filename: a?.filename,
          localPath: a?.localPath,
        };
      }),
      cover.coverId,
    );

    const skus = colors.map((c) => ({ color: c, price: null as string | null }));
    if (!skus.length) {
      skus.push({ color: '色1', price: null });
      needReview = true;
      reviewReasons.push('color_placeholder');
    }

    const tags = [...(suggestion.tags || [])];
    if (subtitle && !tags.includes(subtitle)) tags.push(subtitle);

    // 完成度判定：可靠款号 + 非弱标题 + 颜色非纯占位 → 可自动上架
    const styleOk = !!styleNo && !isProvisionalStyleNo(styleNo) && !styleNoProvisional;
    const titleOk = !isWeakProductTitle(name);
    const colorOk = !isPlaceholderColorList(colors);
    const highComplete = styleOk && titleOk && colorOk;

    if (!styleOk && !reviewReasons.includes('missing_style_no')) {
      reviewReasons.push('missing_style_no');
    }
    if (!titleOk && !reviewReasons.includes('weak_title')) {
      reviewReasons.push('weak_title');
    }
    if (!colorOk && !reviewReasons.includes('color_placeholder')) {
      reviewReasons.push('color_placeholder');
    }

    needReview = !highComplete;
    suggestion.needReview = needReview;
    suggestion.reviewReasons = reviewReasons;
    batch.suggestion = suggestion;

    // 无正式吊牌款号 = 转待补全：保留商品（off_sale + needReview），仅有非吊牌 8 类同样转待补全
    if (!styleOk) {
      const hasHangtagImg = (suggestion.images || []).some((i) => i.role === 'hangtag');
      const hangtagOcr = (suggestion.images || [])
        .filter((i) => i.role === 'hangtag')
        .map((i) => String(i.ocrText || '').trim())
        .join('\n');
      const noteBlob = `${suggestion.ocrNote || ''} ${hangtagOcr} ${subtitle || ''}`;
      // 仅当 OCR/备注明确指向模糊/看不清时才报「吊牌文字不清晰」；
      // 超时 abort → 「吊牌 OCR 超时」；其余无款号 → 「未识别到吊牌款号」。永不编造 styleNo。
      const ocrTimedOut =
        hasHangtagImg &&
        /OCR 超时|aborted|AbortError|ETIMEDOUT|timed?\s*out/i.test(noteBlob);
      const unclearHangtag =
        hasHangtagImg &&
        !ocrTimedOut &&
        (/吊牌.*(不清|模糊|无法辨认|看不清)|看不清.*吊牌|文字模糊|字迹不清/.test(noteBlob) ||
          (/多模态 OCR 无有效文字|几乎无字/.test(noteBlob) && hangtagOcr.length > 0 && hangtagOcr.length < 8));
      if (ocrTimedOut && !reviewReasons.includes('ocr_timeout')) {
        reviewReasons.push('ocr_timeout');
      }
      if (unclearHangtag && !reviewReasons.includes('hangtag_unclear')) {
        reviewReasons.push('hangtag_unclear');
      }
      const failureReason = humanPublishFailureReason({
        subtitle,
        ocrNote: suggestion.ocrNote,
        reviewReasons,
        explicit: ocrTimedOut
          ? REASON_ZH.ocr_timeout
          : unclearHangtag
            ? REASON_ZH.hangtag_unclear
            : REASON_ZH.missing_style_no,
      });
      // 待补全：保留商品（off_sale + needReview），款号等由用户在编辑页补录
      const levelId = String(
        job.input.levelId || process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open',
      );
      const product = await publish.markPendingCompletion(user, {
        batchId,
        productId,
        name,
        material: suggestion.material || null,
        description: suggestion.description || null,
        levelId,
        priceDisplay: (job.input.priceDisplay as any) || 'show',
        coverMediaIds,
        reviewReasons,
        failureReason,
      });
      logger.log(
        `pendingCompletion jobId=${job.id} productId=${productId} draft=${draftStyleNo || '-'} reason=${failureReason}`,
      );
      return {
        recognized: false,
        pendingCompletion: true,
        outcome: '待补全信息',
        failureReason,
        productId: (product as any)?.id || productId,
        styleNo: null,
        draftStyleNo: draftStyleNo || null,
        name: (product as any)?.name || name,
        subtitle: subtitle || null,
        titleSource,
        colorSource,
        colorSourceNote,
        coverMediaId: cover.coverId,
        coverVia: cover.via,
        coverReason: cover.reason,
        skuCount: 0,
        styleNoProvisional: true,
        needReview: true,
        reviewReasons,
        status: 'off_sale',
        highComplete: false,
        sourceMediaIds,
        sourceImages: sourceImages.map((s) => {
          const im = suggestion.images?.find((i) => i.mediaId === s.mediaId);
          return { ...s, role: im?.role || s.role };
        }),
      };
    }

    // 识别成功建品后默认在售；标题弱 / needReview 仅打标，不再自动下架。
    // 仅当调用方显式传 off_sale/draft 时下架。
    let finalStatus: 'on_sale' | 'off_sale' = 'on_sale';
    if (statusIntent === 'off_sale' || statusIntent === 'draft') {
      finalStatus = 'off_sale';
    } else {
      finalStatus = 'on_sale';
    }

    const levelId = String(job.input.levelId || process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open');
    const product = await publish.updateFromPublishJob(user, {
      batchId,
      productId,
      styleNo,
      name,
      material: suggestion.material || null,
      description: suggestion.description || null,
      levelId,
      priceDisplay: (job.input.priceDisplay as any) || 'show',
      status: finalStatus,
      tags,
      skus,
      images,
      coverMediaIds,
      needReview,
      reviewReasons,
    });

    logger.log(
      `done jobId=${job.id} productId=${productId} status=${finalStatus} ` +
        `needReview=${needReview} highComplete=${highComplete} reasons=${reviewReasons.join(',') || '-'}`,
    );

    return {
      recognized: true,
      outcome: '已识别出商品',
      productId: product.id || productId,
      styleNo: product.styleNo || styleNo,
      name: product.name || name,
      subtitle: subtitle || null,
      titleSource,
      colorSource,
      colorSourceNote,
      coverMediaId: cover.coverId,
      coverVia: cover.via,
      coverReason: cover.reason,
      skuCount: skus.length,
      styleNoProvisional: false,
      needReview,
      reviewReasons,
      status: finalStatus,
      highComplete,
      sourceMediaIds,
      sourceImages: sourceImages.map((s) => {
        const im = images.find((i) => i.mediaId === s.mediaId);
        return { ...s, role: im?.role || s.role };
      }),
    };
  };
  jobs.registerHandler('publish_product', handle);
}

function jobUser(job: JobRecord): AuthContext {
  return {
    tenantId: job.tenantId,
    openid: job.userId || 'job-worker',
    role: 'owner',
    memberId: job.userId,
  };
}
