const { request } = require('../../../utils/request');

const STATUS_LABEL = {
  queued: '排队',
  running: '在做',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '取消',
};

const REASON_ZH = {
  missing_style_no: '未识别到吊牌款号',
  weak_title: '无法确认商品名称',
  color_placeholder: '未识别到颜色',
  title_fallback: '标题不可靠',
  empty_title_filled: '标题为空',
  style_no_conflict: '款号与已有商品冲突',
};

const STATUS_TONE = {
  queued: 'warn',
  running: 'run',
  succeeded: 'ok',
  failed: 'err',
  cancelled: 'muted',
};

const TYPE_LABEL = {
  promo_image: '宣传生图',
  promo_video: '宣传视频',
  publish_product: '选图发品',
  cover_reselect: '封面重选',
};

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function enrichJob(j) {
  const progress = j.progress || {};
  const productId =
    j.productId ||
    (j.payload && j.payload.productId) ||
    (j.result && (j.result.productId || (j.result.product && j.result.product.id))) ||
    '';
  const setId =
    j.setId ||
    (j.payload && j.payload.setId) ||
    (j.result && j.result.setId) ||
    '';
  const styleNo =
    j.styleNo ||
    (j.payload && (j.payload.styleNo || j.payload.draftStyleNo)) ||
    (j.result && (j.result.styleNo || (j.result.product && j.result.product.styleNo))) ||
    '';
  const isGenType = j.type === 'promo_image' || j.type === 'promo_video';
  const isCreateType = j.type === 'publish_product';
  const busy = j.status === 'queued' || j.status === 'running';
  const result = j.result || {};
  const resultName = String(result.name || '').trim();
  const resultProvisional = !!result.styleNoProvisional;
  const resultNeedReview = !!result.needReview;
  const resultReasons = Array.isArray(result.reviewReasons)
    ? result.reviewReasons.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const failureReason = String(
    result.failureReason ||
      progress.failureReason ||
      (j.error && String(j.error).replace(/^识别失败：/, '')) ||
      '',
  ).trim();
  const unrecognized =
    isCreateType &&
    (result.recognized === false ||
      result.outcome === '未识别出商品' ||
      resultProvisional ||
      (j.status === 'failed' && /识别失败|未识别/.test(String(j.error || progress.message || ''))));
  const recognized =
    isCreateType &&
    !unrecognized &&
    (result.recognized === true ||
      (!!productId &&
        !resultProvisional &&
        !/^V\d{12}/i.test(String(styleNo || '')) &&
        !!String(styleNo || '').trim()));
  let statusLabel = STATUS_LABEL[j.status] || j.status;
  let tone = STATUS_TONE[j.status] || 'muted';
  let resultSummary = '';
  let failureReasonText = '';
  if (isCreateType && (unrecognized || (j.status === 'failed' && !recognized))) {
    statusLabel = '识别失败';
    tone = 'err';
    const mapped = resultReasons.map((r) => REASON_ZH[r] || r).filter(Boolean);
    failureReasonText =
      failureReason ||
      mapped.join('；') ||
      (String(result.subtitle || '').trim()) ||
      '未识别出商品';
    resultSummary = '识别失败';
  } else if (isCreateType && j.status === 'succeeded' && recognized) {
    statusLabel = '已完成';
    tone = 'ok';
    resultSummary =
      '已识别出商品' +
      (resultName ? '「' + resultName + '」' : '') +
      (styleNo ? '，款号 ' + styleNo : '') +
      '。点「打开商品」进入编辑页。';
    if (resultNeedReview && resultReasons.length) {
      resultSummary +=
        ' 待核对：' +
        resultReasons.map((r) => REASON_ZH[r] || r).join('、') +
        '。';
    }
  } else if (isCreateType && j.status === 'failed') {
    statusLabel = '识别失败';
    tone = 'err';
    failureReasonText = failureReason || String(j.error || progress.message || '识别失败').trim();
    resultSummary = '识别失败';
  }
  const canOpenProduct = !!(isCreateType && recognized && productId);
  const doneTotal =
    progress.done != null && progress.total != null
      ? `${progress.done}/${progress.total}`
      : '';
  return Object.assign({}, j, {
    title:
      j.title ||
      (j.payload && j.payload.displayTitle) ||
      TYPE_LABEL[j.type] ||
      '任务',
    statusLabel,
    tone,
    failureReasonText,
    unrecognized: !!unrecognized,
    recognized: !!recognized,
    typeLabel: TYPE_LABEL[j.type] || j.type,
    productId,
    setId,
    styleNo,
    isGenType,
    isCreateType,
    canRetry: j.status === 'failed' || j.status === 'cancelled' || !!unrecognized,
    canCancel: busy,
    cancelLabel: j.status === 'running' ? '停止' : '取消',
    retryLabel: j.status === 'cancelled'
      ? '重跑'
      : (j.type === 'promo_image' || j.type === 'promo_video' ? '重新生成' : '重试'),
    isOrphan: !!(j.orphanPromoSet || String(j.id || '').indexOf('orphan_') === 0),
    canOpenGallery: !!(isGenType && productId && setId),
    canOpenProduct,
    resultSummary,
    resultName,
    busy,
    doneTotal,
    percent: Number(progress.percent) || 0,
    progressMessage: (() => {
      if (isCreateType && (unrecognized || statusLabel === '识别失败')) return '识别失败';
      if (isCreateType && recognized && j.status === 'succeeded') return '已完成';
      const msg = String(progress.message || '').trim();
      if (!msg) return '';
      if (doneTotal && /(\d+)\s*\/\s*(\d+)/.test(msg)) {
        const m = msg.match(/(\d+)\s*\/\s*(\d+)/);
        const shown = String(doneTotal);
        if (m && shown && !shown.startsWith(m[1] + '/') && shown.split('/')[1] !== m[2]) {
          return '';
        }
      }
      return msg;
    })(),
    progressStep: progress.step || '',
    error: unrecognized ? '' : (j.error || (j.status === 'failed' ? progress.message : '') || ''),
    createdText: fmtTime(j.createdAt),
    attemptsText:
      j.attempts != null
        ? `${j.attempts}/${j.maxAttempts != null ? j.maxAttempts : '-'}`
        : '',
  });
}

Page({
  data: {
    id: '',
    job: null,
    loading: true,
  },

  onLoad(q) {
    this.setData({ id: q.id || '' });
  },
  onShow() {
    if (this.data.id) this.load();
  },
  onHide() { clearTimeout(this.timer); },
  onUnload() { clearTimeout(this.timer); },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    clearTimeout(this.timer);
    const id = this.data.id;
    if (!id) return;
    this.setData({ loading: true });
    try {
      const jobRaw = await request({ url: `/api/jobs/${id}` });
      const job = enrichJob(jobRaw || {});
      // orphan 重试后后端返回真实 jobId：同步到本页，避免继续打 orphan_
      if (job.id && job.id !== id && String(id).indexOf('orphan_') === 0) {
        this.setData({ id: job.id });
      }
      // 发品识别成功：进商品编辑页（未识别则留在详情展示「识别失败」+原因，禁止假跳）
      if (job.isCreateType && job.recognized && job.productId && job.status === 'succeeded') {
        wx.redirectTo({
          url: `/pages/product/edit/edit?id=${job.productId}`,
        });
        return;
      }
      // 生图/视频成功：进该组素材详情
      const needOps = job.status === 'failed' || job.status === 'cancelled' || job.unrecognized;
      if (!needOps && job.isGenType && job.productId && job.setId) {
        wx.redirectTo({
          url: `/pages/product/promo-gallery/promo-gallery?id=${job.productId}&setId=${job.setId}`,
        });
        return;
      }
      this.setData({ job, loading: false });
      if (job.busy) {
        this.timer = setTimeout(() => this.load(), 3000);
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },


  openProduct() {
    const job = this.data.job || {};
    if (!job.recognized || !job.productId) {
      wx.showToast({ title: '未识别出商品，无法打开', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/product/edit/edit?id=${job.productId}`,
    });
  },

  openGallery() {
    const job = this.data.job || {};
    // 必须带 setId，否则会进商品全部素材列表（兄弟任务）
    if (!job.productId || !job.setId) {
      wx.showToast({ title: '无法定位该组素材', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/product/promo-gallery/promo-gallery?id=${job.productId}&setId=${job.setId}`,
    });
  },

  async retry() {
    const id = this.data.id;
    const job = this.data.job || {};
    try {
      const res = await request({ url: `/api/jobs/${id}/retry`, method: 'POST', data: {} });
      if (res && res.id && res.id !== id) {
        this.setData({ id: res.id });
      }
      const label = job.retryLabel === '重新生成' || job.isGenType ? '已开始重新生成' : '已重新排队';
      wx.showToast({ title: label, icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '重试失败', icon: 'none' });
    }
  },

  async cancel() {
    const job = this.data.job || {};
    const verb = job.cancelLabel || '取消';
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: verb + '任务',
        content: `确定${verb}该任务？`,
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    try {
      await request({ url: `/api/jobs/${this.data.id}/cancel`, method: 'POST', data: {} });
      wx.showToast({ title: '已' + verb, icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || verb + '失败', icon: 'none' });
    }
  },


});
