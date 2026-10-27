const { request, ensureSilentSession } = require('../../../utils/request');
const { saveUrlsToAlbum } = require('../../../utils/saveAlbum');
const { maybeCollectProfile, stableMediaUrl } = require('../../../utils/profile');
const { isUserVisibleJobType } = require('../../../utils/job-visibility');

const STATUS_LABEL = {
  generating: '生成中',
  queued: '排队中',
  running: '生成中',
  pending: '待生成',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  succeeded: '已完成',
};


const JOB_STATUS_LABEL = {
  queued: '排队',
  running: '在做',
  succeeded: '完成',
  failed: '失败',
  cancelled: '取消',
};
const JOB_STATUS_TONE = {
  queued: 'warn',
  running: 'run',
  succeeded: 'ok',
  failed: 'err',
  cancelled: 'muted',
};

function mapProductJob(j) {
  const progress = j.progress || {};
  const title =
    j.title ||
    (j.payload && j.payload.displayTitle) ||
    (j.type === 'promo_image' ? '宣传生图' : j.type === 'promo_video' ? '宣传视频' : '任务');
  let hint = '';
  if (j.status === 'failed') hint = String(j.error || progress.message || '').slice(0, 36);
  else if (j.status === 'queued' || j.status === 'running') {
    if (progress.done != null && progress.total != null) hint = `${progress.done}/${progress.total}`;
    else if (progress.message) hint = String(progress.message).slice(0, 36);
  }
  return {
    id: j.id,
    title,
    statusLabel: JOB_STATUS_LABEL[j.status] || j.status,
    tone: JOB_STATUS_TONE[j.status] || 'muted',
    hint,
  };
}

function mapPromoSetCard(s) {
  const kind = s.kind || s.type || 'image';
  const isVideo = kind === 'video' || kind === 'promo_video';
  const items = s.items || [];
  // 视频：优先首帧/封面；图：取前 2～4 张拼贴
  const urls = [];
  if (isVideo) {
    const looksImg = (u) => /\.(jpe?g|png|webp|gif|bmp)(\?|#|$)/i.test(String(u || ''));
    const looksVid = (u) => /\.(mp4|webm|mov)(\?|#|$)/i.test(String(u || ''));
    // 封面优先真正的 poster；不要把 mp4 塞进 <image>；也不要用「假视频」jpg 冒充可播
    const cover =
      s.posterUrl ||
      s.coverUrl ||
      (items.find((i) => i && (i.posterUrl || i.coverUrl) && !looksVid(i.posterUrl || i.coverUrl)) || {});
    let u = '';
    if (typeof cover === 'string') u = cover;
    else u = cover.posterUrl || cover.coverUrl || '';
    if (u && !looksVid(u)) urls.push(u);
    // 若只有 jpg 假成片，仍可作缩略图，但不暗示可播（列表靠 typeLabel）
    if (!urls.length) {
      const thumb = (items.find((i) => i && i.url && looksImg(i.url)) || {}).url || '';
      if (thumb) urls.push(thumb);
    }
  } else {
    items.forEach((i) => {
      if (i && i.url && urls.length < 4) urls.push(i.url);
    });
  }
  const thumbUrls = urls.slice(0, 4);
  const thumbCount = thumbUrls.length;
  const thumbUrl = thumbUrls[0] || '';
  const done = s.done != null ? s.done : items.filter((i) => i && i.url).length;
  const total = s.total != null ? s.total : items.length;
  const busy = !!(s.busy || s.status === 'generating' || s.status === 'queued' || s.status === 'running');
  let statusClass = 'ok';
  if (busy) statusClass = 'run';
  else if (s.status === 'failed') statusClass = 'err';
  const title = s.displayTitle || s.templateName || (isVideo ? '宣传视频' : '宣传图');
  return {
    id: s.id || s.setId,
    title,
    thumbUrl,
    thumbUrls,
    thumbCount,
    isVideo,
    typeLabel: isVideo ? '视频' : '图',
    typeShort: isVideo ? '视频' : '图',
    statusLabel: STATUS_LABEL[s.status] || s.status || '',
    statusClass,
    metaText: isVideo
      ? (() => {
          const sec = Math.round(Number(s.seconds || s.durationSec || (s.params && s.params.seconds) || 0) || 0);
          const base = total ? `${done}/${total}` : '';
          return sec > 0 ? (base ? `${base} · 约${sec}秒` : `约${sec}秒`) : base;
        })()
      : (total ? `${done}/${total} 张` : ''),
  };
}

Page({
  data: {
    product: null,
    isStaff: false,
    canDownload: false,
    shareMode: 'limited',
    id: '',
    shareEventId: '',
    boundCustomerId: '',
    moreProducts: [],
    previewUrl: '',
    promoSets: [],
    promoSetsLoading: false,
    productJobs: [],
    productJobsLoading: false,
    contactQrUrl: '',
  },
  async onLoad(q) {
    const app = getApp();
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    // 分享链路一律进客户专用页，避免员工角色打开后露出管理控件
    if (shareEventId) {
      const qs = [`id=${q.id || ''}`, `shareEventId=${shareEventId}`];
      if (boundCustomerId) qs.push(`boundCustomerId=${boundCustomerId}`);
      wx.redirectTo({ url: `/pages/product/view/view?${qs.join('&')}` });
      return;
    }
    this.setData({
      id: q.id,
      shareEventId,
      boundCustomerId,
      isStaff: app.globalData.role === 'staff' || app.globalData.role === 'owner',
    });
    await this.load(q.id, shareEventId, boundCustomerId);
    // 禁用右上角菜单分享：名额/策略只能经页内「发给微信好友」按钮在发卡前创建
    try {
      wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) {
      try { wx.hideShareMenu(); } catch (e2) { /* */ }
    }
  },
  onShow() {
    if (this.data.isStaff && this.data.id) {
      this.refreshOwnerTasks(this.data.id);
    }
  },
  async refreshOwnerTasks(productId) {
    await this.loadPromoSets(productId);
    await this.loadProductJobs(productId);
  },
  async load(id, shareEventId, boundCustomerId) {
    try {
      let url = `/api/products/${id}`;
      const qs = [];
      if (shareEventId) qs.push(`shareEventId=${shareEventId}`);
      if (boundCustomerId) qs.push(`boundCustomerId=${boundCustomerId}`);
      if (qs.length) url += `?${qs.join('&')}`;
      const product = await request({ url });
      const isStaff = this.data.isStaff;
      const canDownload = isStaff || !!product.allowCustomerDownload;
      this.setData({ product, canDownload });
      if (isStaff) {
        this.refreshOwnerTasks(id);
        // 预创建 share，避免右上角/按钮同步 path 落到无 shareId 的 landing
        this.prefetchShare();
      } else {
        this.loadMoreProducts(id, shareEventId, boundCustomerId);
        this.loadContactQr();
        maybeCollectProfile();
      }
    } catch (e) {
      wx.showToast({ title: e.message || '无权查看', icon: 'none' });
    }
  },
  async loadPromoSets(productId) {
    if (!productId) return;
    this.setData({ promoSetsLoading: true });
    try {
      const setsRaw = await request({ url: `/api/products/${productId}/promo/sets` });
      const list = Array.isArray(setsRaw) ? setsRaw : (setsRaw && setsRaw.items) || [];
      this.setData({
        promoSets: list.map(mapPromoSetCard),
        promoSetsLoading: false,
      });
    } catch (e) {
      this.setData({ promoSetsLoading: false });
      /* 列表失败不挡详情 */
    }
  },
  /**
   * 业主「本商品任务」：仅 user-facing 生图/视频（进行中/失败的 promo_set）。
   * 分析图、发品、封面等系统 job 不展示；成功素材在「素材」→ 宣传素材页。
   */
  async loadProductJobs(productId) {
    if (!productId) return;
    this.setData({ productJobsLoading: true });
    try {
      const tasks = [];
      const sets = this.data.promoSets || [];
      sets.forEach((s) => {
        const busy = s.statusClass === 'run';
        const failed = s.statusClass === 'err' || s.statusLabel === '失败';
        if (!busy && !failed) return;
        tasks.push({
          id: s.id,
          kind: 'set',
          setId: s.id,
          productId,
          title: s.title || '宣传素材',
          statusLabel: s.statusLabel || (busy ? '生成中' : '失败'),
          tone: busy ? 'run' : 'err',
          hint: s.metaText || '',
        });
      });
      // 兜底：无 set 表达的 user-facing job（与任务中心同一白名单）
      const res = await request({ url: `/api/jobs?productId=${productId}&limit=30` });
      const seenSets = {};
      tasks.forEach((t) => { if (t.setId) seenSets[t.setId] = true; });
      ((res && res.items) || []).forEach((j) => {
        if (!isUserVisibleJobType(j && j.type)) return;
        const st = j.status;
        if (st !== 'queued' && st !== 'running' && st !== 'failed') return;
        const setId = (j.payload && j.payload.setId) || (j.result && j.result.setId) || '';
        if (setId && seenSets[setId]) return;
        tasks.push(Object.assign(mapProductJob(j), { kind: 'job', setId }));
      });
      this.setData({ productJobs: tasks, productJobsLoading: false });
    } catch (e) {
      this.setData({ productJobsLoading: false });
    }
  },
  goJobDetail(e) {
    const ds = e.currentTarget.dataset || {};
    const kind = ds.kind || '';
    const setId = ds.setId || '';
    const id = ds.id || '';
    if (kind === 'set' || setId) {
      const sid = setId || id;
      wx.navigateTo({
        url: `/pages/product/promo-gallery/promo-gallery?id=${this.data.id}&setId=${sid}`,
      });
      return;
    }
    if (!id) return;
    wx.navigateTo({ url: `/pages/jobs/detail/detail?id=${id}` });
  },
  async loadMoreProducts(currentId, shareEventId, boundCustomerId) {
    try {
      const qs = ['levelId=pl_open', 'status=on_sale', 'pageSize=8'];
      if (shareEventId) qs.push(`shareEventId=${shareEventId}`);
      if (boundCustomerId) qs.push(`boundCustomerId=${boundCustomerId}`);
      const res = await request({ url: `/api/products?${qs.join('&')}` });
      const items = ((res && res.items) || [])
        .filter((p) => p && p.id && p.id !== currentId)
        .slice(0, 6);
      this.setData({ moreProducts: items });
    } catch (e) {
      /* ignore */
    }
  },
  /** 预览与下载解耦：点图始终 previewImage；下载靠长按/保存按钮 */
  previewImage(e) {
    const images = (this.data.product && this.data.product.images) || [];
    const urls = images.map((im) => im && im.url).filter(Boolean);
    if (!urls.length) return;
    let idx = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= urls.length) {
      const url = e.currentTarget.dataset.url;
      idx = Math.max(0, urls.indexOf(url));
    }
    wx.previewImage({
      urls,
      current: urls[idx],
      fail: () => wx.showToast({ title: '无法预览图片', icon: 'none' }),
    });
  },
  closePreview() {
    this.setData({ previewUrl: '' });
  },
  noop() {},
  async saveAllImages() {
    if (!this.data.canDownload) {
      wx.showToast({ title: '未开放下载', icon: 'none' });
      return;
    }
    const urls = ((this.data.product && this.data.product.images) || []).map((im) => im.url).filter(Boolean);
    if (!urls.length) return;
    wx.showLoading({ title: '保存中' });
    try {
      const r = await saveUrlsToAlbum(urls);
      wx.hideLoading();
      wx.showToast({
        title: r.fail ? `成功${r.ok} 失败${r.fail}` : `已保存 ${r.ok} 张`,
        icon: r.fail ? 'none' : 'success',
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    }
  },
  goEdit() {
    wx.navigateTo({ url: `/pages/product/edit/edit?id=${this.data.id}` });
  },
  goMoreProduct(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const qs = [`id=${id}`];
    if (this.data.shareEventId) qs.push(`shareEventId=${this.data.shareEventId}`);
    if (this.data.boundCustomerId) qs.push(`boundCustomerId=${this.data.boundCustomerId}`);
    wx.navigateTo({ url: `/pages/product/detail/detail?${qs.join('&')}` });
  },
  onShareModeTap(e) {
    const v = e.currentTarget.dataset.v;
    if (v === 'open' || v === 'limited') {
      this.setData({ shareMode: v });
      this.prefetchShare();
    }
  },
  prefetchShare() {
    this.ensureShareForNative().catch(() => { /* 预热失败不挡详情 */ });
  },
  async ensureShareForNative() {
    const policy = this.data.shareMode === 'open' ? 'open' : 'designated_only';
    const cacheKey = policy;
    if (this._shareCache && this._shareCache[cacheKey] && this._shareCache[cacheKey].shareId) {
      return this._shareCache[cacheKey];
    }
    const res = await request({
      url: '/api/shares',
      method: 'POST',
      data: { productId: this.data.id, sharePolicy: policy },
    });
    if (!this._shareCache) this._shareCache = {};
    this._shareCache[cacheKey] = res;
    return res;
  },
  /** 分享卡封面：优先商品封面，其次首图（微信会裁成约 5:4） */
  shareCardImageUrl() {
    const product = this.data.product || {};
    const images = product.images || [];
    return (
      product.coverUrl ||
      (images[0] && images[0].url) ||
      ''
    );
  },
  onShareAppMessage(res) {
    const product = this.data.product || {};
    const title = (product.name || product.styleNo || '商品分享').trim();
    const imageUrl = this.shareCardImageUrl();
    // 分享卡片目标：landing → 客户专用 view；绝不能落到员工 detail
    const policy = this.data.shareMode === 'open' ? 'open' : 'designated_only';
    const cached = this._shareCache && this._shareCache[policy];
    const productId = this.data.id || (product && product.id) || '';
    const landingPath = (sid) => `/pages/share/landing/landing?shareId=${sid}`;
    // 无 shareId 时带 productId 降级，避免同步 path 落到裸 landing（微信可能先用 sync 再等 promise）
    const fallbackPath = productId
      ? `/pages/share/landing/landing?productId=${productId}`
      : '/pages/share/landing/landing';
    const syncPath = (cached && cached.shareId)
      ? landingPath(cached.shareId)
      : fallbackPath;
    // 右上角菜单已 hide；若仍触发则尽量用已缓存 share / productId 降级
    if (!res || res.from !== 'button') {
      return { title, path: syncPath, imageUrl: imageUrl || undefined };
    }
    // 页内 open-type=share：先按所选模式创建 share，再发卡
    return {
      title,
      path: syncPath,
      imageUrl: imageUrl || undefined,
      promise: this.ensureShareForNative()
        .then((shareRes) => {
          const shareId = shareRes.shareId;
          // 必须与 app.json 注册页一致：pages/share/landing/landing
          const path = shareId
            ? landingPath(shareId)
            : (shareRes.path || fallbackPath);
          return { title, path, imageUrl: imageUrl || undefined };
        })
        .catch((err) => {
          wx.showToast({ title: (err && err.message) || '分享准备失败', icon: 'none' });
          // 失败也不回员工 detail；降级带 productId 直开客户详情
          return { title, path: fallbackPath, imageUrl: imageUrl || undefined };
        }),
    };
  },
  onShareTimeline() {
    // 朋友圈入口已 hideShareMenu；不经页内按钮，不创建 share
    const product = this.data.product || {};
    const title = (product.name || product.styleNo || '商品分享').trim();
    const imageUrl = this.shareCardImageUrl();
    return {
      title,
      query: `id=${this.data.id}`,
      imageUrl: imageUrl || undefined,
    };
  },
  async loadContactQr() {
    try {
      const tenant = await request({ url: '/api/tenants/current' });
      this.setData({ contactQrUrl: (stableMediaUrl((tenant && tenant.contactQrUrl) || '') || '') });
    } catch (e) {
      /* ignore */
    }
  },
  goInquiry() {
    wx.navigateTo({
      url: `/pages/inquiry/detail/detail?productId=${this.data.id}&mode=create`,
    });
  },
});
