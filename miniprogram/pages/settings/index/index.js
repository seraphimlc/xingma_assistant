const { request } = require('../../../utils/request');
const { saveProfileWithAvatarUpload } = require('../../../utils/profile');

Page({
  data: {
    showProfile: true,
    nickname: '',
    avatarUrl: '',
    phone: '',
    contactQrUrl: '',
    allowCustomerDownload: false,
    isOwner: false,
    inviteRole: 'staff',
    invites: [],
    members: [],
    latestInvite: null,
    customerLevels: [],
    productLevels: [],
    // 新建客户等级
    clCode: '',
    clName: '',
    clRank: '1',
    clDefault: false,
    // 新建商品等级
    plCode: '',
    plName: '',
    plRank: '0',
    plPolicy: 'designated_only',
    plMinRank: '',
  },
  onLoad(q) {
    if (q && q.profile === '1') this.setData({ showProfile: true });
  },
  onShow() {
    this.load();
  },
  async load() {
    try {
      const app = getApp();
      const role = (app.globalData && app.globalData.role) || wx.getStorageSync('role') || '';
      const isOwner = role === 'owner';
      const tasks = [
        request({ url: '/api/levels/customer' }),
        request({ url: '/api/levels/product' }),
        request({ url: '/api/auth/me' }).catch(() => null),
        request({ url: '/api/tenants/current' }).catch(() => null),
        request({ url: '/api/invites/members' }).catch(() => []),
      ];
      if (isOwner) tasks.push(request({ url: '/api/invites' }).catch(() => []));
      const results = await Promise.all(tasks);
      const customerLevels = results[0];
      const productLevels = results[1];
      const me = results[2];
      const tenant = results[3];
      const members = results[4] || [];
      const invites = isOwner ? (results[5] || []) : [];
      this.setData({
        isOwner,
        customerLevels: customerLevels || [],
        productLevels: productLevels || [],
        nickname: (me && me.nickname) || '',
        avatarUrl: (me && me.avatarUrl) || '',
        phone: (me && me.phone) || '',
        contactQrUrl: (tenant && tenant.contactQrUrl) || '',
        allowCustomerDownload: !!(tenant && tenant.allowCustomerDownload),
        members,
        invites,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (url) this.setData({ avatarUrl: url });
  },
  onNickname(e) {
    const nickname = ((e.detail && e.detail.value) || '').trim();
    this.setData({ nickname });
  },
  async saveProfileTap() {
    const nickname = (this.data.nickname || '').trim();
    const avatarUrl = this.data.avatarUrl || '';
    if (!nickname && !avatarUrl) {
      wx.showToast({ title: '请先点选头像或昵称', icon: 'none' });
      return;
    }
    try {
      const { avatarUrl: persisted, nickname: nick } = await saveProfileWithAvatarUpload({
        nickname: nickname || undefined,
        avatarUrl: avatarUrl || undefined,
      });
      const patch = {};
      if (persisted) patch.avatarUrl = persisted;
      if (nick != null) patch.nickname = nick;
      if (Object.keys(patch).length) this.setData(patch);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },
  pickContactQr() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const path = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!path) return;
        // 本地临时路径先直接回写（生产可改为上传 media）；小程序可展示本地/https
        try {
          // 若已有上传接口则优先；否则用本地路径仅开发可见——改为上传到商品无关的 media
          const app = getApp();
          const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
          const token = app.globalData.token || wx.getStorageSync('token') || '';
          const upload = await new Promise((resolve, reject) => {
            wx.uploadFile({
              url: baseUrl + '/api/media/upload',
              filePath: path,
              name: 'file',
              header: { Authorization: token ? `Bearer ${token}` : '' },
              formData: { purpose: 'contact_qr' },
              success: (r) => {
                try {
                  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
                  if (r.statusCode >= 200 && r.statusCode < 300) resolve(data);
                  else reject(new Error((data && data.message) || '上传失败'));
                } catch (e) { reject(e); }
              },
              fail: reject,
            });
          });
          const url = upload.url || upload.publicUrl || upload.avatarUrl || path;
          await request({
            url: '/api/tenants/current/contact-qr',
            method: 'PATCH',
            data: { url },
          });
          this.setData({ contactQrUrl: url });
          wx.showToast({ title: '二维码已更新', icon: 'none' });
        } catch (e) {
          // 无上传接口时：直接存临时路径不可跨端，提示
          wx.showToast({ title: (e && e.message) || '请配置媒体上传', icon: 'none' });
        }
      },
    });
  },
  async clearContactQr() {
    try {
      await request({ url: '/api/tenants/current/contact-qr', method: 'PATCH', data: { url: null } });
      this.setData({ contactQrUrl: '' });
      wx.showToast({ title: '已清除', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async onAllowDownloadTap(e) {
    const v = e.currentTarget.dataset.v;
    const allow = v === '1' || v === 1;
    try {
      await request({
        url: '/api/tenants/current/allow-customer-download',
        method: 'PATCH',
        data: { allowCustomerDownload: allow },
      });
      this.setData({ allowCustomerDownload: allow });
      wx.showToast({ title: allow ? '已允许客户存图' : '已禁止客户存图', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
  onClCode(e) { this.setData({ clCode: e.detail.value }); },
  onClName(e) { this.setData({ clName: e.detail.value }); },
  onClRank(e) { this.setData({ clRank: e.detail.value }); },
  onClDefault(e) { this.setData({ clDefault: !!e.detail.value.length }); },
  async addCustomerLevel() {
    try {
      await request({
        url: '/api/levels/customer',
        method: 'POST',
        data: {
          code: this.data.clCode.trim(),
          name: this.data.clName.trim(),
          rank: parseInt(this.data.clRank, 10) || 0,
          isDefault: this.data.clDefault,
        },
      });
      this.setData({ clCode: '', clName: '', clRank: '1', clDefault: false });
      this.load();
      wx.showToast({ title: '已添加' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async setDefaultCl(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({
        url: `/api/levels/customer/${id}`,
        method: 'PATCH',
        data: { isDefault: true },
      });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
  async deleteCl(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({ url: `/api/levels/customer/${id}`, method: 'DELETE' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
  onPlCode(e) { this.setData({ plCode: e.detail.value }); },
  onPlName(e) { this.setData({ plName: e.detail.value }); },
  onPlRank(e) { this.setData({ plRank: e.detail.value }); },
  onPlPolicy(e) { this.setData({ plPolicy: e.detail.value }); },
  onPlMinRank(e) { this.setData({ plMinRank: e.detail.value }); },
  async addProductLevel() {
    try {
      await request({
        url: '/api/levels/product',
        method: 'POST',
        data: {
          code: this.data.plCode.trim(),
          name: this.data.plName.trim(),
          rank: parseInt(this.data.plRank, 10) || 0,
          defaultSharePolicy: this.data.plPolicy,
          minCustomerRank: this.data.plMinRank === '' ? null : parseInt(this.data.plMinRank, 10),
        },
      });
      this.setData({ plCode: '', plName: '', plRank: '0', plPolicy: 'designated_only', plMinRank: '' });
      this.load();
      wx.showToast({ title: '已添加' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async deletePl(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({ url: `/api/levels/product/${id}`, method: 'DELETE' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
  onInviteRole(e) {
    this.setData({ inviteRole: e.detail.value });
  },
  async createInvite() {
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const inv = await request({
        url: '/api/invites',
        method: 'POST',
        data: { role: this.data.inviteRole || 'staff', maxUses: 1, expiresInDays: 7 },
      });
      wx.hideLoading();
      this.setData({ latestInvite: inv });
      this.load();
      wx.showToast({ title: '已生成', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '失败', icon: 'none' });
    }
  },
  copyInviteCode(e) {
    const code = (e.currentTarget.dataset && e.currentTarget.dataset.code) || (this.data.latestInvite && this.data.latestInvite.code);
    if (!code) return;
    wx.setClipboardData({
      data: String(code),
      success: () => wx.showToast({ title: '已复制邀请码', icon: 'none' }),
    });
  },
  async revokeInvite(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    try {
      await request({ url: `/api/invites/${id}/revoke`, method: 'POST' });
      if (this.data.latestInvite && this.data.latestInvite.id === id) {
        this.setData({ latestInvite: null });
      }
      this.load();
      wx.showToast({ title: '已撤销', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '失败', icon: 'none' });
    }
  },

});
