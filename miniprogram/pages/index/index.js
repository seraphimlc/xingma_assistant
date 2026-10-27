const { loginAs, wxLogin } = require('../../utils/request');
const inviteUtil = require('../../utils/invite');

Page({
  data: {
    role: '',
    roleLabel: '',
    tenantId: '',
    isStaff: false,
    customerHint: '请通过分享卡片打开',
    showDevLogin: false,
    pendingInviteCode: '',
  },
  onLoad(q) {
    this._captureInvite(q);
  },
  onShow() {
    this._captureInvite();
    const app = getApp();
    const role = app.globalData.role || '';
    const base = app.globalData.baseUrl || '';
    const showDevLogin = /127\.0\.0\.1|localhost/.test(base);
    const isStaff = role === 'owner' || role === 'staff';
    let pending = inviteUtil.readPendingInviteCode();
    // 已是档口成员：清掉残留邀请码，避免每次进首页被踢去 accept
    if (pending && isStaff && app.globalData.token) {
      inviteUtil.clearPendingInviteCode();
      pending = '';
    }
    // 分享进线后点「房子」落到首页：立刻带回邀请落地页，勿当客户登录
    if (pending && !isStaff) {
      wx.reLaunch({
        url: `/pages/invite/accept/accept?code=${encodeURIComponent(pending)}`,
      });
      return;
    }
    this.setData({
      role,
      roleLabel: this.labelOf(role),
      tenantId: app.globalData.tenantId,
      isStaff,
      showDevLogin,
      pendingInviteCode: pending || '',
    });
    // 已登录员工：直接进三 tab 首页（默认商品）
    if (isStaff && app.globalData.token) {
      wx.switchTab({ url: '/pages/product/list/list' });
    }
  },
  _captureInvite(q) {
    try {
      const code = inviteUtil.extractInviteCode(q || {}) || inviteUtil.readPendingInviteCode();
      if (code) inviteUtil.savePendingInviteCode(code);
    } catch (e) { /* */ }
  },
  labelOf(role) {
    if (role === 'owner') return '业主';
    if (role === 'staff') return '员工';
    if (role === 'customer') return '客户';
    return '';
  },
  errText(e) {
    const m = (e && (e.message || e.errMsg)) || '';
    return (m && String(m)) || '登录失败';
  },
  /** 业主/员工：微信登录；若本地有待兑换邀请码则一并赎回，避免被判成客户 */
  async enterWithWechat() {
    const pending = inviteUtil.readPendingInviteCode();
    if (pending) {
      wx.reLaunch({
        url: `/pages/invite/accept/accept?code=${encodeURIComponent(pending)}`,
      });
      return;
    }
    wx.showLoading({ title: '登录中', mask: true });
    try {
      const session = await wxLogin('owner');
      wx.hideLoading();
      if (session.role !== 'owner' && session.role !== 'staff') {
        this.logout();
        wx.showToast({ title: '非档口成员，请打开业主发来的邀请卡片加入', icon: 'none', duration: 2500 });
        return;
      }
      this.goWorkbench();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: this.errText(e).slice(0, 40), icon: 'none', duration: 3500 });
    }
  },
  async enterAsStaff() {
    wx.showLoading({ title: '登录中', mask: true });
    try {
      await loginAs('staff');
      wx.hideLoading();
      this.goWorkbench();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: this.errText(e).slice(0, 40), icon: 'none', duration: 3500 });
    }
  },
  goWorkbench() {
    wx.switchTab({ url: '/pages/product/list/list' });
  },
  logout() {
    const app = getApp();
    app.globalData.token = '';
    app.globalData.role = '';
    wx.removeStorageSync('token');
    wx.removeStorageSync('role');
    this.onShow();
  },
});
