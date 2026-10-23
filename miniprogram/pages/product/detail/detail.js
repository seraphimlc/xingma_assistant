const { request, ensureSilentSession } = require('../../../utils/request');
const { saveUrlsToAlbum } = require('../../../utils/saveAlbum');
const { maybeCollectProfile } = require('../../../utils/profile');

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

function mapPromoSetCard(s) {
  const kind = s.kind || s.type || 'image';
  const isVideo = kind === 'video' || kind === 'promo_video';
  const items = s.items || [];
  // 视频：优先首帧/封面；图：取前 2～4 张拼贴
  const urls = [];
  if (isVideo) {
    const cover =
      s.posterUrl ||
      s.coverUrl ||
      (items.find((i) => i && (i.posterUrl || i.coverUrl || i.url)) || {});
    const u = cover.posterUrl || cover.coverUrl || cover.url || '';
    if (u) urls.push(u);
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
      ? (total ? `${done}/${total}` : '')
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
    contactQrUrl: '',
  },
  async onLoad(q) {
    const app = getApp();
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    this.setData({
      id: q.id,
      shareEventId,
      boundCustomerId,
      isStaff: app.globalData.role === 'staff' || app.globalData.role === 'owner',
    });
    if (shareEventId && !app.globalData.token) {
      try {
        await ensureSilentSession({ preferRole: 'customer' });
        this.setData({
          isStaff: app.globalData.role === 'staff' || app.globalData.role === 'owner',
        });
      } catch (e) {
        wx.showToast({ title: e.message || '鉴权失败', icon: 'none' });
        return;
      }
    }
    await this.load(q.id, shareEventId, boundCustomerId);
    if (this.data.isStaff) {
      try {
        wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
      } catch (e) { /* */ }
    }
  },
  onShow() {
    if (this.data.isStaff && this.data.id) {
      this.loadPromoSets(this.data.id);
    }
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
        this.loadPromoSets(id);
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
  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    const urls = ((this.data.product && this.data.product.images) || []).map((im) => im.url).filter(Boolean);
    if (!url || !urls.length) return;
    if (this.data.canDownload) {
      wx.previewImage({ urls, current: url });
    } else {
      this.setData({ previewUrl: url });
    }
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
  /** 点某组 → 素材列表并展开该组详情 */
  goPromoSet(e) {
    const setId = e.currentTarget.dataset.id;
    if (!setId) return;
    wx.navigateTo({
      url: `/pages/product/promo-gallery/promo-gallery?id=${this.data.id}&setId=${setId}`,
    });
  },
  /** 新建素材：先选图片/视频，再直达对应新建页（绕过素材列表中间页） */
  goPromoMaterials() {
    const id = this.data.id;
    if (!id) return;
    wx.showActionSheet({
      itemList: ['新建图片', '新建视频'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/product/promo/promo?id=${id}&type=image` });
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: `/pages/product/promo/promo?id=${id}&type=video` });
        }
      },
    });
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
    if (v === 'open' || v === 'limited') this.setData({ shareMode: v });
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
  onShareAppMessage() {
    const product = this.data.product || {};
    const title = (product.name || product.styleNo || '商品分享').trim();
    const images = product.images || [];
    const imageUrl = (images[0] && images[0].url) || product.coverUrl || '';
    const fallbackPath = `/pages/product/detail/detail?id=${this.data.id}`;
    return {
      title,
      path: fallbackPath,
      imageUrl: imageUrl || undefined,
      promise: this.ensureShareForNative()
        .then((res) => {
          const path = res.path || `/pages/share/landing?shareId=${res.shareId}`;
          return { title, path, imageUrl: imageUrl || undefined };
        })
        .catch((err) => {
          wx.showToast({ title: (err && err.message) || '分享准备失败', icon: 'none' });
          return { title, path: fallbackPath, imageUrl: imageUrl || undefined };
        }),
    };
  },
  onShareTimeline() {
    const product = this.data.product || {};
    const title = (product.name || product.styleNo || '商品分享').trim();
    const images = product.images || [];
    const imageUrl = (images[0] && images[0].url) || product.coverUrl || '';
    const open = this._shareCache && this._shareCache.open;
    const query = open && open.shareId
      ? `shareId=${open.shareId}`
      : `id=${this.data.id}`;
    return {
      title,
      query,
      imageUrl: imageUrl || undefined,
    };
  },
  async loadContactQr() {
    try {
      const tenant = await request({ url: '/api/tenants/current' });
      this.setData({ contactQrUrl: (tenant && tenant.contactQrUrl) || '' });
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
