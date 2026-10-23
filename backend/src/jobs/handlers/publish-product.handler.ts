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
  provisionalStyleNo,
} from '../../vision/publish-vision';
import { AuthContext } from '../../common/interfaces/auth-context.interface';
import {
  ColorSuggestionSource,
  PublishSuggestion,
  TitleSuggestionSource,
} from '../../products/publish/publish.types';

const logger = new Logger('PublishJob');

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
        `note=${String(suggestion.ocrNote || '').slice(0, 200)}`,
    );

    await ctx.updateProgress({ percent: 35, step: 'cover', message: '多模态选封面' });

    const batch = publish.getBatch(user.tenantId, batchId);
    const cands = batch.assets.map((a) => {
      const img = suggestion?.images?.find((i) => i.mediaId === a.mediaId);
      return {
        id: a.mediaId,
        localPath: a.localPath,
        filename: a.filename,
        roleHint: img?.role,
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
      if (coverAsset?.localPath) titlePaths.push(coverAsset.localPath);
      for (const a of batch.assets) {
        const im = suggestion.images?.find((i) => i.mediaId === a.mediaId);
        if (im?.role === 'hangtag') continue;
        if (a.localPath && !titlePaths.includes(a.localPath)) titlePaths.push(a.localPath);
      }
      if (!titlePaths.length && batch.assets[0]?.localPath) {
        titlePaths.push(batch.assets[0].localPath);
      }
      const gen = await generateProductTitle(vision, titlePaths.slice(0, 4), {
        styleNo: ocrStyleNo || undefined,
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
      const preferRoles = new Set(['multi_color', 'main']);
      for (const a of batch.assets) {
        const im = suggestion.images?.find((i) => i.mediaId === a.mediaId);
        if (im && preferRoles.has(im.role)) colorPaths.push(a.localPath);
      }
      const coverPath = batch.assets.find((a) => a.mediaId === cover.coverId)?.localPath;
      if (coverPath && !colorPaths.includes(coverPath)) colorPaths.unshift(coverPath);
      if (!colorPaths.length) {
        colorPaths.push(...batch.assets.slice(0, 3).map((a) => a.localPath));
      }
      const est = await estimateGarmentColors(vision, colorPaths);
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
      message: `封面已选(${cover.via})，更新草稿`,
    });

    // OCR/分析款号优先；其次用户入队指定；再保留草稿临时款号；最后新生成
    let styleNo = String(suggestion.styleNo || '').trim();
    if (!styleNo) styleNo = String(job.input.styleNo || '').trim();
    if (!styleNo) styleNo = String(job.input.draftStyleNo || '').trim();
    let styleNoProvisional = false;
    if (!styleNo) {
      styleNo = provisionalStyleNo(batchId);
      styleNoProvisional = true;
      needReview = true;
      reviewReasons.push('missing_style_no');
      logger.log(`provisional styleNo jobId=${job.id} productId=${productId} ${styleNo}`);
    } else if (isProvisionalStyleNo(styleNo)) {
      styleNoProvisional = true;
      needReview = true;
      if (!reviewReasons.includes('missing_style_no')) reviewReasons.push('missing_style_no');
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

    // 用户 enqueue 时选了 draft 则尊重；否则高完成度 → on_sale，否则 draft
    let finalStatus: 'on_sale' | 'off_sale' | 'draft' = 'draft';
    if (statusIntent === 'draft') {
      finalStatus = 'draft';
    } else if (statusIntent === 'off_sale') {
      finalStatus = 'off_sale';
    } else if (highComplete) {
      finalStatus = 'on_sale';
    } else {
      finalStatus = 'draft';
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
      styleNoProvisional,
      needReview,
      reviewReasons,
      status: finalStatus,
      highComplete,
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
