const { request } = require('../../../utils/request');

const STATUS_LABEL = {
  queued: '排队',
  running: '在做',
  succeeded: '完成',
  failed: '失败',
  cancelled: '取消',
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
    (j.payload && j.payload.setId) ||
    (j.result && j.result.setId) ||
    '';
  const styleNo =
    j.styleNo ||
    (j.payload && (j.payload.styleNo || j.payload.draftStyleNo)) ||
    (j.result && (j.result.styleNo || (j.result.product && j.result.product.styleNo))) ||
    '';
  const isGenType = j.type === 'promo_image' || j.type === 'promo_video' || j.type === 'cover_reselect';
  const isCreateType = j.type === 'publish_product';
  const busy = j.status === 'queued' || j.status === 'running';
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
    statusLabel: STATUS_LABEL[j.status] || j.status,
    tone: STATUS_TONE[j.status] || 'muted',
    typeLabel: TYPE_LABEL[j.type] || j.type,
    productId,
    setId,
    styleNo,
    canRetry: j.status === 'failed' || j.status === 'cancelled',
    canCancel: busy,
    cancelLabel: j.status === 'running' ? '停止' : '取消',
    retryLabel: j.status === 'cancelled' ? '重跑' : '重试',
    busy,
    doneTotal,
    percent: Number(progress.percent) || 0,
    progressMessage: progress.message || '',
    progressStep: progress.step || '',
    error: j.error || (j.status === 'failed' ? progress.message : '') || '',
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
      this.setData({ job, loading: false });
      if (job.busy) {
        this.timer = setTimeout(() => this.load(), 3000);
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  async retry() {
    const id = this.data.id;
    try {
      await request({ url: `/api/jobs/${id}/retry`, method: 'POST', data: {} });
      wx.showToast({ title: '已重新排队', icon: 'none' });
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
