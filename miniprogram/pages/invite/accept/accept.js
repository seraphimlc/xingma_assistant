/**
 * 员工/业主邀请落地：分享 path query 静默带 code（或 scene）
 * 微信登录 → 带 inviteCode 换 JWT → 绑定成员 → 强制补齐头像+昵称（缺一不可；手机选填）→ 进工作台
 */
const { request } = require('../../../utils/request');
const inviteUtil = require('../../../utils/invite');
const {
  missingProfileFields,
  saveProfileWithAvatarUpload,
  stableMediaUrl,
} = require('../../../utils/profile');

Page({
  data: {
    loading: true,
    error: '',
    code: '',
    roleLabel: '',
    needProfile: false,
    needAvatar: false,
    needNickname: false,
    needPhone: false,
    nickname: '',
    avatarUrl: '',
    phone: '',
    phoneBinding: false,
    saving: false,
  },
  onLoad(q) {
    this._hideHome();
    let code = inviteUtil.extractInviteCode(q || '');
    if (!code) code = inviteUtil.readPendingInviteCode();
    code = inviteUtil.normalizeCode(code);
    if (code) inviteUtil.savePendingInviteCode(code);
    this.setData({ code });
    this.run(code);
  },
  onShow() {
    this._hideHome();
  },
  _hideHome() {
    try {
      if (typeof wx.hideHomeButton === 'function') wx.hideHomeButton();
    } catch (e) { /* */ }
  },
  async run(code) {
    code = inviteUtil.normalizeCode(code);
    if (!code) {
      this.setData({ loading: false, error: '请打开业主发来的微信邀请卡片加入' });
      return;
    }
    inviteUtil.savePendingInviteCode(code);
    wx.showLoading({ title: '加入中', mask: true });
    try {
      const app = getApp();
      const base = (app.globalData && app.globalData.baseUrl) || '';
      const allowFake = /127\.0\.0\.1|localhost/.test(base);
      let session;
      if (allowFake) {
        session = await request({
          url: '/api/auth/login',
          method: 'POST',
          data: {
            code: `dev_invite_${Date.now()}`,
            tenantId: app.globalData.tenantId,
            preferRole: 'staff',
            inviteCode: code,
          },
        });
        app.setSession(session);
      } else {
        try {
          app.globalData.token = '';
          app.globalData.role = '';
          wx.removeStorageSync('token');
          wx.removeStorageSync('role');
        } catch (e) { /* */ }
        const wxCode = await new Promise((resolve, reject) => {
          wx.login({
            success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 无 code'))),
            fail: (e) => reject(new Error((e && e.errMsg) || 'wx.login 失败')),
          });
        });
        session = await request({
          url: '/api/auth/login',
          method: 'POST',
          data: { code: wxCode, inviteCode: code, preferRole: 'staff' },
        });
        app.setSession(session);
      }
      wx.hideLoading();
      if (session.role !== 'owner' && session.role !== 'staff') {
        this.setData({ loading: false, error: '绑定失败，仍为客户角色。请让业主重新发微信邀请卡片' });
        return;
      }
      inviteUtil.clearPendingInviteCode();
      const roleLabel = session.role === 'owner' ? '业主' : '员工';
      this.setData({ loading: false, roleLabel, error: '' });
      await this.ensureProfileOrEnter();
    } catch (e) {
      wx.hideLoading();
      this.setData({ loading: false, error: (e && e.message) || '加入失败' });
    }
  },
  async ensureProfileOrEnter() {
    let me = null;
    try {
      me = await request({ url: '/api/auth/me' });
    } catch (e) {
      me = null;
    }
    const miss = missingProfileFields(me);
    const needAvatar = miss.indexOf('avatar') >= 0;
    const needNickname = miss.indexOf('nickname') >= 0;
    // 邀请加入：头像+昵称强制（缺一不可）；手机选填，不挡进入
    if (!needAvatar && !needNickname) {
      this.enterWorkbench();
      return;
    }
    this.setData({
      needProfile: true,
      needAvatar,
      needNickname,
      needPhone: false,
      nickname: (me && me.nickname) || '',
      avatarUrl: stableMediaUrl((me && me.avatarUrl) || '') || '',
      phone: (me && me.phone) || '',
    });
  },
  enterWorkbench() {
    wx.showToast({ title: `已加入（${this.data.roleLabel || '员工'}）`, icon: 'success' });
    setTimeout(() => {
      wx.switchTab({ url: '/pages/product/list/list' });
    }, 500);
  },
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    this.setData({ avatarUrl: url });
  },
  onNickname(e) {
    this.setData({ nickname: (e.detail && e.detail.value) || '' });
  },
  onPhoneInput(e) {
    this.setData({ phone: (e.detail && e.detail.value) || '' });
  },
  async onGetPhoneNumber(e) {
    const detail = (e && e.detail) || {};
    if (!detail.code) {
      wx.showToast({ title: '已取消或无法授权', icon: 'none' });
      return;
    }
    this.setData({ phoneBinding: true });
    try {
      const me = await request({
        url: '/api/auth/me/phone',
        method: 'POST',
        data: { code: detail.code },
      });
      const phone = (me && me.phone) || '';
      if (phone) this.setData({ phone, needPhone: false });
      wx.showToast({ title: '已获取手机号', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '获取失败', icon: 'none' });
    } finally {
      this.setData({ phoneBinding: false });
    }
  },
  async saveProfileAndEnter() {
    if (this.data.saving) return;
    const nickname = (this.data.nickname || '').trim();
    const avatarUrl = (this.data.avatarUrl || '').trim();
    const phone = (this.data.phone || '').trim();
    // 头像+昵称缺一不可（已有字段也会带上，保证两端都齐）
    if (!avatarUrl) {
      wx.showToast({ title: '请选择微信头像', icon: 'none' });
      return;
    }
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const payload = {};
      payload.nickname = nickname;
      payload.avatarUrl = avatarUrl;
      if (phone) payload.phone = phone;
      payload.uploadAvatarIfTemp = true;
      await saveProfileWithAvatarUpload(payload);
      this.setData({ needProfile: false, saving: false });
      this.enterWorkbench();
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    }
  },
  retry() {
    const code = inviteUtil.normalizeCode(this.data.code || inviteUtil.readPendingInviteCode());
    this.setData({ loading: true, error: '', code, needProfile: false });
    this.run(code);
  },
  goHome() {
    inviteUtil.clearPendingInviteCode();
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
