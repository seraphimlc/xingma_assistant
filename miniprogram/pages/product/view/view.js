/**
 * 客户专用商品详情（分享落地目标页）。
 * 与 pages/product/detail（员工管理页）分离：本页永不渲染管理控件。
 */
const { request, ensureSilentSession } = require('../../../utils/request');
const {
  hasContactInfo,
  hasAvatarAndNickname,
  isContactPrompted,
  markContactPrompted,
  markProfilePrompted,
  saveProfileWithAvatarUpload,
  stableMediaUrl,
} = require('../../../utils/profile');

function skuHasPrice(s) {
  if (!s) return false;
  const p = s.price;
  if (p == null) return false;
  const t = String(p).trim();
  return t !== '' && t !== '询价' && t !== '未标价';
}

function formatSkuPrice(p) {
  const t = String(p).trim();
  if (/^¥/.test(t) || /^￥/.test(t)) return t;
  return `¥${t}`;
}

/** 客户页不展示发品内部标记 */
function publicTags(tags) {
  return (tags || []).filter((t) => {
    if (t == null) return false;
    const s = String(t).trim();
    if (!s) return false;
    if (s === 'needReview' || s === 'provisionalStyleNo' || s === '识别中') return false;
    if (s.indexOf('review:') === 0) return false;
    return true;
  });
}

Page({
  data: {
    product: null,
    canDownload: false,
    id: '',
    shareEventId: '',
    boundCustomerId: '',
    groupId: '',
    showCatalogCta: false,
    homeFabTop: 88,
    homeFabSize: 32,
    contactQrUrl: '',
    error: '',
    hasPrice: false,
    showContactPriceHint: false,
    skuRows: [],
    showSoftTip: false,
    showInquirySheet: false,
    tryOnAvailable: false,
    showProfileSheet: false,
    contactPhone: '',
    contactName: '',
    contactRemark: '',
    profilePhone: '',
    profileName: '',
    profileAvatarUrl: '',
    profileDraftNick: '',
    profileDraftPhone: '',
    profileSaving: false,
    needProfileAvatar: false,
    needProfileNickname: false,
    needProfilePhone: false,
    profileSheetTitle: '完善资料',
    profileSheetDesc: '',
  },
  async onLoad(q) {
    this._layoutHomeFab();
    this._hideNativeHome();
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    const id = q.id || '';
    this.setData({ id, shareEventId, boundCustomerId });
    try {
      if (!getApp().globalData.token) {
        await ensureSilentSession({ preferRole: 'customer' });
      }
    } catch (e) {
      this.setData({ error: (e && e.message) || '鉴权失败' });
      return;
    }
    await Promise.all([
      this.load(id, shareEventId, boundCustomerId),
      this.loadProfileForInquiry(),
    ]);
    try {
      wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) {
      try { wx.hideShareMenu(); } catch (e2) { /* */ }
    }
  },
  buildSkuState(product) {
    const skus = (product && product.skus) || [];
    const rows = skus.map((s) => ({
      id: s.id || s.skuCode || s.color,
      color: s.color || '-',
      price: s.price,
      priceText: skuHasPrice(s) ? formatSkuPrice(s.price) : '',
    }));
    const hasPrice = rows.some((r) => r.priceText);
    return {
      skuRows: rows,
      hasPrice,
      showContactPriceHint: rows.length > 0 ? !hasPrice : !hasPrice,
    };
  },
  async load(id, shareEventId, boundCustomerId) {
    if (!id) {
      this.setData({ error: '缺少商品参数' });
      return;
    }
    try {
      let url = `/api/products/${id}`;
      const qs = [];
      if (shareEventId) qs.push(`shareEventId=${shareEventId}`);
      if (boundCustomerId) qs.push(`boundCustomerId=${boundCustomerId}`);
      if (qs.length) url += `?${qs.join('&')}`;
      const product = await request({ url });
      const skuState = this.buildSkuState(product);
      const safe = Object.assign({}, product, { tags: publicTags(product.tags) });
      const groupId = product.groupId || '';
      this.setData({
        product: safe,
        canDownload: !!product.allowCustomerDownload,
        groupId,
        // 客户分享落地页：房子/「更多」始终进公开目录，不依赖 groupId
        showCatalogCta: true,
        error: '',
        ...skuState,
      });
      this.loadContactQr();
      this.refreshTryOn(id, shareEventId, boundCustomerId);
    } catch (e) {
      this.setData({ error: (e && e.message) || '无权查看' });
      wx.showToast({ title: (e && e.message) || '无权查看', icon: 'none' });
    }
  },
  async refreshTryOn(id, shareEventId, boundCustomerId) {
    if (!id) {
      this.setData({ tryOnAvailable: false });
      return;
    }
    try {
      let url = `/api/products/${id}/tryon`;
      const qs = [];
      if (shareEventId) qs.push(`shareEventId=${encodeURIComponent(shareEventId)}`);
      if (boundCustomerId) qs.push(`boundCustomerId=${encodeURIComponent(boundCustomerId)}`);
      if (qs.length) url += `?${qs.join('&')}`;
      const data = await request({ url });
      const colors = (data && data.colors) || [];
      this.setData({ tryOnAvailable: !!(data && data.available && colors.length) });
    } catch (e) {
      this.setData({ tryOnAvailable: false });
    }
  },
  async openTryOn() {
    if (this._openingTryOn || !this.data.tryOnAvailable) return;
    const id = this.data.id || (this.data.product && this.data.product.id);
    if (!id) return;
    this._openingTryOn = true;
    wx.showLoading({ title: '打开试衣', mask: true });
    try {
      const data = await request({
        url: `/api/products/${id}/tryon/ticket`,
        method: 'POST',
        data: {
          shareEventId: this.data.shareEventId || undefined,
          boundCustomerId: this.data.boundCustomerId || undefined,
        },
      });
      const ticket = data && data.ticket;
      if (!ticket) throw new Error('无法开始试衣');
      wx.setStorageSync('tryonLaunch', { productId: id, ticket, at: Date.now() });
      const query = `productId=${encodeURIComponent(id)}&ticket=${encodeURIComponent(ticket)}`;
      const route = `/pages/product/tryon/tryon?${query}`;
      wx.navigateTo({
        url: route.length < 900 ? route : `/pages/product/tryon/tryon?productId=${encodeURIComponent(id)}`,
      });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '无法开始试衣', icon: 'none' });
    } finally {
      this._openingTryOn = false;
      wx.hideLoading();
    }
  },
  async loadContactQr() {
    try {
      const tenant = await request({ url: '/api/tenants/current' });
      this.setData({ contactQrUrl: stableMediaUrl((tenant && tenant.contactQrUrl) || '') || '' });
    } catch (e) {
      /* ignore */
    }
  },
  previewImage(e) {
    const images = (this.data.product && this.data.product.images) || [];
    const urls = images.map((im) => im && im.url).filter(Boolean);
    if (!urls.length) return;
    let idx = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= urls.length) idx = 0;
    const current = urls[idx];
    wx.previewImage({
      urls,
      current,
      fail: (err) => {
        console.warn('previewImage fail', err);
        wx.showToast({ title: '无法预览图片', icon: 'none' });
      },
    });
  },

  /** 预填联系方式；缺头像或昵称则强制完善（缺一不可，不可跳过）；手机选填 */
  async loadProfileForInquiry() {
    try {
      const me = await request({ url: '/api/auth/me' });
      const phone = (me && me.phone) || '';
      const name = (me && me.nickname) || '';
      const avatar = (me && me.avatarUrl) || '';
      this.setData({
        profilePhone: phone,
        profileName: name,
        profileAvatarUrl: avatar,
        contactPhone: phone,
        contactName: name,
        profileDraftNick: name,
        profileDraftPhone: phone,
      });
      if (hasAvatarAndNickname(me)) {
        markProfilePrompted();
        if (hasContactInfo(me)) markContactPrompted();
      } else {
        // 强制：遮罩挡交互直至头像+昵称都齐；手机不强制
        this.setData({
          showProfileSheet: true,
          showSoftTip: false,
          needProfileAvatar: true,
          needProfileNickname: true,
          needProfilePhone: false,
          profileSheetTitle: '完善微信资料',
          profileSheetDesc: '请授权微信头像和昵称（缺一不可），方便档口认出你',
        });
        return;
      }
      if (!hasContactInfo(me) && !isContactPrompted()) {
        this.setData({ showSoftTip: true });
      } else if (hasContactInfo(me)) {
        markContactPrompted();
      }
    } catch (e) {
      /* 档案拉取失败时不挡看货；下次进入再试强制资料 */
    }
  },
  /** 兼容旧绑定：强制模式下不可跳过 */
  skipProfileSheet() {
    wx.showToast({ title: '请先完善头像和昵称', icon: 'none' });
  },
  onProfileChooseAvatar(e) {
    const url = (e.detail && e.detail.avatarUrl) || '';
    if (url) this.setData({ profileAvatarUrl: url });
  },
  onProfileNick(e) {
    this.setData({ profileDraftNick: e.detail.value });
  },
  onProfilePhone(e) {
    this.setData({ profileDraftPhone: e.detail.value });
  },
  async onProfileGetPhone(e) {
    const detail = (e && e.detail) || {};
    if (detail.errno === 1400001) {
      wx.showToast({ title: '手机号额度不足', icon: 'none' });
      return;
    }
    if (!detail.code) {
      const denied = (detail.errMsg || '').indexOf('deny') >= 0;
      wx.showToast({ title: denied ? '已取消授权' : '无法获取微信手机号', icon: 'none' });
      return;
    }
    try {
      const me = await request({
        url: '/api/auth/me/phone',
        method: 'POST',
        data: { code: detail.code },
      });
      const phone = (me && me.phone) || '';
      if (phone) {
        this.setData({
          profileDraftPhone: phone,
          profilePhone: phone,
          contactPhone: phone,
        });
        wx.showToast({ title: '已填入手机号', icon: 'success' });
      }
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '微信手机号不可用', icon: 'none' });
    }
  },
  async saveProfileSheet() {
    if (this.data.profileSaving) return;
    const nickname = (this.data.profileDraftNick || '').trim();
    const phone = (this.data.profileDraftPhone || '').trim();
    const avatarUrl = (this.data.profileAvatarUrl || '').trim();
    if (!avatarUrl) {
      wx.showToast({ title: '请选择微信头像', icon: 'none' });
      return;
    }
    if (!nickname) {
      wx.showToast({ title: '请填写微信昵称', icon: 'none' });
      return;
    }
    if (phone && !/^1\d{10}$/.test(phone) && !/^\+?\d{6,20}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不太对', icon: 'none' });
      return;
    }
    this.setData({ profileSaving: true });
    try {
      const saved = await saveProfileWithAvatarUpload({
        nickname,
        phone: phone || undefined,
        avatarUrl,
        uploadAvatarIfTemp: true,
      });
      markProfilePrompted();
      markContactPrompted();
      const nextNick = (saved && saved.nickname) || nickname;
      const nextPhone = (saved && saved.phone) || phone;
      const nextAvatar = (saved && saved.avatarUrl) || avatarUrl;
      if (!hasAvatarAndNickname({ nickname: nextNick, avatarUrl: nextAvatar })) {
        this.setData({ profileSaving: false });
        wx.showToast({ title: '头像和昵称都要填', icon: 'none' });
        return;
      }
      this.setData({
        showProfileSheet: false,
        profileSaving: false,
        needProfileAvatar: false,
        needProfileNickname: false,
        needProfilePhone: false,
        profileSheetTitle: '完善资料',
        profileSheetDesc: '',
        profileName: nextNick,
        profilePhone: nextPhone,
        profileAvatarUrl: nextAvatar,
        profileDraftNick: nextNick,
        profileDraftPhone: nextPhone,
        contactName: nextNick,
        contactPhone: nextPhone,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      this.setData({ profileSaving: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
  dismissSoftTip() {
    markContactPrompted();
    this.setData({ showSoftTip: false });
  },
  async openInquirySheet() {
    // 每次打开尽量用最新档案预填
    try {
      const me = await request({ url: '/api/auth/me' });
      const phone = (me && me.phone) || this.data.profilePhone || '';
      const name = (me && me.nickname) || this.data.profileName || '';
      this.setData({
        contactPhone: phone,
        contactName: name,
        contactRemark: '',
        showInquirySheet: true,
        showProfileSheet: false,
        showSoftTip: false,
        profilePhone: phone,
        profileName: name,
      });
    } catch (e) {
      this.setData({
        showInquirySheet: true,
        showProfileSheet: false,
        showSoftTip: false,
        contactPhone: this.data.profilePhone || '',
        contactName: this.data.profileName || '',
        contactRemark: '',
      });
    }
  },
  closeInquirySheet() {
    this.setData({ showInquirySheet: false });
  },
  onContactPhone(e) {
    this.setData({ contactPhone: e.detail.value });
  },
  onContactName(e) {
    this.setData({ contactName: e.detail.value });
  },
  onContactRemark(e) {
    this.setData({ contactRemark: e.detail.value });
  },
  noop() {},
  async submitInquiry() {
    const phone = (this.data.contactPhone || '').trim();
    const name = (this.data.contactName || '').trim();
    const remark = (this.data.contactRemark || '').trim();
    const productId = this.data.id || (this.data.product && this.data.product.id);
    if (!productId) {
      wx.showToast({ title: '缺少商品', icon: 'none' });
      return;
    }
    if (!phone && !name) {
      wx.showToast({ title: '请填手机或姓名', icon: 'none' });
      return;
    }
    if (phone && !/^1\d{10}$/.test(phone) && !/^\+?\d{6,20}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不太对', icon: 'none' });
      return;
    }
    if (this._submittingInquiry) return;
    this._submittingInquiry = true;
    try {
      await request({
        url: '/api/inquiries',
        method: 'POST',
        data: {
          productId,
          phone: phone || undefined,
          name: name || undefined,
          remark: remark || undefined,
        },
      });
      markContactPrompted();
      this.setData({
        showInquirySheet: false,
        profilePhone: phone || this.data.profilePhone,
        profileName: name || this.data.profileName,
      });
      wx.showToast({ title: '已提交询价', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
    } finally {
      this._submittingInquiry = false;
    }
  },

  onShow() {
    this._hideNativeHome();
  },

  /** 分享单页模式下系统左上角房子会进首页/管理端 Tab；隐藏之，只用自定义 FAB→catalog */
  _hideNativeHome() {
    try {
      if (typeof wx.hideHomeButton === 'function') wx.hideHomeButton();
    } catch (e) { /* ignore */ }
  },

  /** t336: 房子在导航栏下方左侧（原生 nav 不可覆盖；系统 home 已 hide） */
  _layoutHomeFab() {
    try {
      const sys = wx.getSystemInfoSync() || {};
      const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
      if (menu && menu.height) {
        this.setData({
          homeFabTop: Math.round(menu.bottom + 8),
          homeFabSize: Math.round(menu.height),
        });
        return;
      }
      const status = sys.statusBarHeight || 20;
      this.setData({ homeFabTop: status + 48, homeFabSize: 32 });
    } catch (e) { /* keep defaults */ }
  },

  /** 房子 FAB 与「更多」共用：客户上下文永远进公开 catalog，绝不进管理端 list */
  goCatalog() {
    const groupId = this.data.groupId || (this.data.product && this.data.product.groupId) || '';
    const qs = [];
    if (groupId) qs.push(`groupId=${encodeURIComponent(groupId)}`);
    if (this.data.shareEventId) qs.push(`shareEventId=${encodeURIComponent(this.data.shareEventId)}`);
    if (this.data.boundCustomerId) qs.push(`boundCustomerId=${encodeURIComponent(this.data.boundCustomerId)}`);
    const url = qs.length
      ? `/pages/product/catalog/catalog?${qs.join('&')}`
      : '/pages/product/catalog/catalog';
    wx.navigateTo({ url });
  },
});
