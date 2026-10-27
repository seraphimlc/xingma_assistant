const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');
const { isUserVisibleJobType } = require('../../../utils/job-visibility');

const STATUS_LABEL = {
  queued: '排队',
  running: '在做',
  succeeded: '已完成',
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
  let statusLabel = STATUS_LABEL[j.status] || j.status;
  let tone = STATUS_TONE[j.status] || 'muted';
  const res = j.result || {};
  const pubFail =
    j.type === 'publish_product' &&
    (res.recognized === false ||
      res.outcome === '未识别出商品' ||
      res.styleNoProvisional === true ||
      (j.status === 'failed' && /识别失败|未识别/.test(String(j.error || (j.progress && j.progress.message) || ''))));
  if (pubFail) {
    statusLabel = '识别失败';
    tone = 'err';
  } else if (j.type === 'publish_product' && j.status === 'succeeded') {
    statusLabel = '已完成';
  }
  // 宣传失败/取消可重试；发品「识别失败」禁止重试
  const isPromo = j.type === 'promo_image' || j.type === 'promo_video';
  const isOrphan = !!(j.orphanPromoSet || String(j.id || '').indexOf('orphan_') === 0);
  const canRetry = !pubFail && (j.status === 'failed' || j.status === 'cancelled');
  const canCancel = j.status === 'queued' || j.status === 'running';
  const cancelLabel = j.status === 'running' ? '停止' : '取消';
  const retryLabel = j.status === 'cancelled' ? '重跑' : (isPromo ? '重新生成' : '重试');
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
  let styleNo =
    j.styleNo ||
    (j.payload && (j.payload.styleNo || j.payload.draftStyleNo)) ||
    (j.result && (j.result.styleNo || (j.result.product && j.result.product.styleNo))) ||
    '';
  if (pubFail || /^V\d{12}/i.test(String(styleNo || ''))) styleNo = '';
  const rawMsg = progress.message || '';
  const looksLikeId = /^(job_|pj_|ps_)[a-z0-9]+$/i.test(String(rawMsg).trim())
    || /^[a-f0-9]{6,}$/i.test(String(rawMsg).trim());
  const title =
    j.title ||
    (j.payload && j.payload.displayTitle) ||
    (rawMsg && !looksLikeId && rawMsg !== '排队中' && rawMsg !== '执行中' ? rawMsg : '') ||
    (j.type === 'promo_image' ? '宣传生图' : j.type === 'promo_video' ? '宣传视频' : j.type === 'publish_product' ? '图片发品' : '任务');
  const productThumb = j.productThumb || (j.sourceImages && j.sourceImages[0] && j.sourceImages[0].url) || '';
  const doneTotal =
    progress.done != null && progress.total != null
      ? `${progress.done}/${progress.total}`
      : '';
  const isCreateType = false;
  const isGenType = isUserVisibleJobType(j.type);
  // 「查看」：生图/视频进素材组
  const canView = true;
  // 生图/视频：始终展示 done/total（含局部重生后仍为整组 N）；其它类型仅忙时提示
  const busyHint =
    isPromo && doneTotal
      ? doneTotal
      : j.status === 'running' || j.status === 'queued'
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
    isOrphan,
    orphanPromoSet: isOrphan,
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
      { id: 'promo_image', name: '生图' },
      { id: 'publish_product', name: '发品' },
      { id: 'promo_video', name: '生视频' },
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
      // 仅 user-facing（promo_image/promo_video）；「全部」含排队/在做/失败/最近完成，不藏 succeeded
      // 系统 job（发品/分析图等）由后端 + 前端白名单共同隐藏
      const raw = (res.items || []).filter((j) => isUserVisibleJobType(j.type));
      const items = raw.map(enrich);
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
    const row = (this.data.list || []).find((j) => j.id === id) || {};
    try {
      await request({ url: `/api/jobs/${id}/retry`, method: 'POST', data: {} });
      wx.showToast({ title: row.retryLabel === '重新生成' ? '已开始重新生成' : '已重新排队', icon: 'none' });
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

  /**
   * 业主「查看」：只打开「这一条」任务/素材组。
   * - 失败/取消 → 任务详情（重新生成）
   * - 生图/视频且有 setId → 该组详情（不带 setId 绝不进商品全部素材列表，避免看到兄弟任务）
   * - 其余 → 单任务详情
   * 全部素材列表仅商品页「素材」等入口故意进入。
   */
  openView(e) {
    const ds = e.currentTarget.dataset || {};
    const id = ds.id;
    const productId = ds.productId || '';
    const setId = ds.setId || '';
    const isGen = ds.isGen === true || ds.isGen === 'true' || ds.isGen === 1 || ds.isGen === '1';
    // 兜底：从当前列表项再取一次（dataset 偶发丢空串）
    const row = (this.data.list || []).find((j) => j.id === id) || {};
    const pid = productId || row.productId || '';
    const sid = setId || row.setId || '';
    const gen = isGen || row.isGenType;
    // 失败/取消：进任务详情（有「重新生成」）
    const needJobOps = row.status === 'failed' || row.status === 'cancelled';
    if (needJobOps && id) {
      wx.navigateTo({ url: `/pages/jobs/detail/detail?id=${id}` });
      return;
    }
    if (gen && pid && sid) {
      wx.navigateTo({
        url: `/pages/product/promo-gallery/promo-gallery?id=${pid}&setId=${sid}`,
      });
      return;
    }
    // 无 setId：绝不再打开商品级素材列表（会露出兄弟组）
    if (!id) return;
    wx.navigateTo({ url: `/pages/jobs/detail/detail?id=${id}` });
  },
});
