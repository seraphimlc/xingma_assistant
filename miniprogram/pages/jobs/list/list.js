const publishQueue = require('../../../utils/publish-upload-queue');
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

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function enrich(j) {
  const progress = j.progress || {};
  const statusLabel = STATUS_LABEL[j.status] || j.status;
  const tone = STATUS_TONE[j.status] || 'muted';
  // 失败一律可重试；取消后也可重跑（后端会重置 attempts）
  const canRetry = j.status === 'failed' || j.status === 'cancelled';
  const canCancel = j.status === 'queued' || j.status === 'running';
  const cancelLabel = j.status === 'running' ? '停止' : '取消';
  const retryLabel = j.status === 'cancelled' ? '重跑' : '重试';
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
  const rawMsg = progress.message || '';
  const looksLikeId = /^(job_|pj_|ps_)[a-z0-9]+$/i.test(String(rawMsg).trim())
    || /^[a-f0-9]{6,}$/i.test(String(rawMsg).trim());
  const title =
    j.title ||
    (j.payload && j.payload.displayTitle) ||
    (rawMsg && !looksLikeId && rawMsg !== '排队中' && rawMsg !== '执行中' ? rawMsg : '') ||
    (j.type === 'promo_image' ? '宣传生图' : j.type === 'publish_product' ? '选图发品' : '任务');
  const productThumb = j.productThumb || '';
  const doneTotal =
    progress.done != null && progress.total != null
      ? `${progress.done}/${progress.total}`
      : '';
  const isCreateType = j.type === 'publish_product';
  const isGenType = j.type === 'promo_image' || j.type === 'cover_reselect' || j.type === 'promo_video';
  // 「查看」：一律进任务明细（进度/错误/关联素材组）
  const canView = true;
  const busyHint =
    j.status === 'running' || j.status === 'queued'
      ? doneTotal || (progress.step && progress.step !== 'queued' && progress.step !== 'running'
        ? progress.step
        : '')
      : '';
  const errHint = j.status === 'failed' ? (j.error || progress.message || '') : '';
  return Object.assign({}, j, {
    title,
    statusLabel,
    tone,
    canRetry,
    canCancel,
    cancelLabel,
    retryLabel,
    productId,
    setId,
    styleNo,
    productThumb,
    doneTotal,
    busyHint,
    errHint: errHint ? String(errHint).slice(0, 40) : '',
    createdText: fmtTime(j.createdAt),
    canView,
    isGenType,
    isCreateType,
  });
}

function ensureStaff() {
  const app = getApp();
  const role = app.globalData.role || '';
  const token = app.globalData.token || '';
  if (!token || (role !== 'owner' && role !== 'staff')) {
    wx.reLaunch({ url: '/pages/index/index' });
    return false;
  }
  return true;
}

Page({
  data: {
    list: [],
    total: 0,
    loading: true,
    status: '',
    type: '',
    statusChips: [
      { id: '', name: '全部' },
      { id: 'queued', name: '排队' },
      { id: 'running', name: '在做' },
      { id: 'succeeded', name: '完成' },
      { id: 'failed', name: '失败' },
      { id: 'cancelled', name: '已取消' },
    ],
    typeChips: [
      { id: '', name: '全部类型' },
      { id: 'publish_product', name: '发品' },
      { id: 'promo_image', name: '生图' },
      { id: 'cover_reselect', name: '封面' },
    ],
  },

  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    this.load();
  },
  onHide() {
    clearTimeout(this.timer);
  },
  onUnload() {
    clearTimeout(this.timer);
  },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onStatus(e) {
    this.setData({ status: e.currentTarget.dataset.id || '' });
    this.load();
  },
  onType(e) {
    this.setData({ type: e.currentTarget.dataset.id || '' });
    this.load();
  },

  async load() {
    clearTimeout(this.timer);
    this.setData({ loading: true });
    try {
      const qs = ['limit=50'];
      if (this.data.status) qs.push(`status=${this.data.status}`);
      if (this.data.type) qs.push(`type=${this.data.type}`);
      const res = await request({ url: `/api/jobs?${qs.join('&')}` });
      const items = (res.items || []).map(enrich);
      this.setData({ list: items, total: res.total || items.length, loading: false });
      const busy = items.some((j) => j.status === 'queued' || j.status === 'running');
      if (busy) {
        this.timer = setTimeout(() => this.load(), 3000);
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  async retry(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({ url: `/api/jobs/${id}/retry`, method: 'POST', data: {} });
      wx.showToast({ title: '已重新排队', icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '重试失败', icon: 'none' });
    }
  },

  async cancel(e) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.list || []).find((j) => j.id === id) || {};
    const verb = item.cancelLabel || '取消';
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: verb + '任务',
        content: `确定${verb}该任务？`,
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    try {
      await request({ url: `/api/jobs/${id}/cancel`, method: 'POST', data: {} });
      wx.showToast({ title: '已' + verb, icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || verb + '失败', icon: 'none' });
    }
  },

  /** 统一「查看」：进任务明细（进度/错误/关联素材），不直接整商品素材页 */
  openView(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/jobs/detail/detail?id=${id}` });
  },
});
