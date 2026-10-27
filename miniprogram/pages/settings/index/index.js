const { request } = require('../../../utils/request');
const { saveProfileWithAvatarUpload, isTempAvatarPath, stableMediaUrl } = require('../../../utils/profile');

/** 员工邀请分享卡封面：公网 https（OSS xingma-stall/static），勿用本地/空路径 */
const INVITE_SHARE_COVER_URL =
  'https://xy-tradex.oss-cn-shenzhen.aliyuncs.com/xingma-stall/static/invite-share-cover.jpg';

function inviteStatusLabel(status) {
  const map = {
    active: '有效',
    revoked: '已撤销',
    exhausted: '已用完',
    expired: '已过期',
  };
  return map[status] || status || '';
}

Page({
  data: {
    showProfile: true,
    nickname: '',
    avatarUrl: '',
    phone: '',
    phoneBinding: false,
    needProfileGuide: false,
    profileSaving: false,
    contactQrUrl: '',
    isOwner: false,
    canInvite: false,
    myMemberId: '',
    invites: [],
    members: [],
    latestInvite: null,
  },
  _nickSaveTimer: null,
  onLoad(q) {
    if (q && q.profile === '1') this.setData({ showProfile: true });
  },
  onShow() {
    try {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
    } catch (e) { /* ignore */ }
    this.load();
  },
  async load() {
    try {
      const app = getApp();
      const role = (app.globalData && app.globalData.role) || wx.getStorageSync('role') || '';
      const isOwner = role === 'owner';
      const canInvite = role === 'owner' || role === 'staff';
      const tasks = [
        request({ url: '/api/auth/me' }).catch(() => null),
        request({ url: '/api/tenants/current' }).catch(() => null),
        request({ url: '/api/invites/members' }).catch(() => []),
      ];
      if (canInvite) tasks.push(request({ url: '/api/invites' }).catch(() => []));
      const results = await Promise.all(tasks);
      const me = results[0];
      const tenant = results[1];
      const rawMembers = results[2] || [];
      // 前端不展示 openid；统一显示为员工（平权）
      const members = (Array.isArray(rawMembers) ? rawMembers : []).map((m) => ({
        id: m.id,
        nickname: m.nickname || '',
        avatarUrl: stableMediaUrl(m.avatarUrl || '') || '',
        phone: m.phone || '',
        status: m.status,
        role: 'staff',
        displayName: (m.nickname || '').trim() || (m.phone || '').trim() || '未设昵称',
        nickShort: ((m.nickname || '').trim() || (m.phone || '').trim() || '员').slice(0, 1),
        whoLine: [m.nickname, m.phone].filter((x) => (x || '').trim()).join(' · ') || '未完善资料',
      }));
      const rawInvites = canInvite ? (results[3] || []) : [];
      const invites = (Array.isArray(rawInvites) ? rawInvites : []).map((inv) => ({
        ...inv,
        statusLabel: inviteStatusLabel(inv && inv.status),
      }));
      // 刷新后恢复「最新有效邀请」，避免转发按钮丢 code 落到无码 accept
      const latestInvite =
        invites.find((inv) => inv && inv.status === 'active') ||
        this.data.latestInvite ||
        null;
      const nickname = (me && me.nickname) || '';
      const avatarUrl = stableMediaUrl((me && me.avatarUrl) || '') || '';
      const phone = (me && me.phone) || '';
      const needProfileGuide = !nickname || !avatarUrl;
      this.setData({
        isOwner,
        canInvite,
        myMemberId: (me && me.memberId) || '',
        nickname,
        avatarUrl,
        phone,
        needProfileGuide,
        contactQrUrl: stableMediaUrl((tenant && tenant.contactQrUrl) || '') || '',
        members,
        invites,
        latestInvite,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    this.setData({ avatarUrl: url });
    this.persistProfile({ avatarUrl: url });
  },
  /** 从各事件里抠昵称；微信「用微信昵称」时 detail 常为空，需靠 form submit */
  _pickNickname(...candidates) {
    for (let i = 0; i < candidates.length; i++) {
      const raw = candidates[i];
      if (raw == null) continue;
      const s = String(raw).trim();
      if (s) return s.slice(0, 64);
    }
    return '';
  },
  _rememberNickname(nickname) {
    if (!nickname) return;
    this._pendingNickname = nickname;
    if (nickname !== this.data.nickname) this.setData({ nickname });
  },
  onNicknameInput(e) {
    const nickname = this._pickNickname(e.detail && e.detail.value);
    if (nickname) this._rememberNickname(nickname);
  },
  /** 非聚焦态内容变化（含部分基础库下微信昵称回填） */
  onNicknameChange(e) {
    const nickname = this._pickNickname(e.detail && e.detail.value);
    if (!nickname) return;
    this._rememberNickname(nickname);
    this.scheduleNicknameSave(nickname);
  },
  onNickname(e) {
    const nickname = this._pickNickname(
      e.detail && e.detail.value,
      this._pendingNickname,
      this.data.nickname,
    );
    if (!nickname) return;
    this._rememberNickname(nickname);
    this.scheduleNicknameSave(nickname);
  },
  onNicknameReview(e) {
    const pass = !!(e.detail && e.detail.pass);
    const timeout = !!(e.detail && e.detail.timeout);
    // review 事件本身不含昵称值；有 pending/data 才自动存。无值时请点「保存昵称」(form)。
    const nickname = this._pickNickname(
      e.detail && (e.detail.value || e.detail.nickname),
      this._pendingNickname,
      this.data.nickname,
    );
    if (!pass && !timeout) {
      wx.showToast({ title: '昵称未通过微信校验', icon: 'none' });
      return;
    }
    if (nickname) {
      this._rememberNickname(nickname);
      this.scheduleNicknameSave(nickname);
    } else if (pass) {
      wx.showToast({ title: '请再点「保存昵称」', icon: 'none' });
    }
  },
  /** form submit：唯一可靠拿到「用微信昵称」回填值的路径（不依赖 bindinput） */
  onNicknameFormSubmit(e) {
    const formNick = e.detail && e.detail.value && e.detail.value.nickname;
    const nickname = this._pickNickname(formNick, this._pendingNickname, this.data.nickname);
    if (!nickname) {
      wx.showToast({ title: '请先填写或点选微信昵称', icon: 'none' });
      return;
    }
    this._rememberNickname(nickname);
    this.persistProfile({ nickname });
  },
  scheduleNicknameSave(nickname) {
    if (!nickname) return;
    if (this._nickSaveTimer) clearTimeout(this._nickSaveTimer);
    this._nickSaveTimer = setTimeout(() => {
      this._nickSaveTimer = null;
      this.persistProfile({ nickname });
    }, 120);
  },
  async onGetPhoneNumber(e) {
    const detail = (e && e.detail) || {};
    if (detail.errno === 1400001) {
      wx.showToast({ title: '手机号额度不足', icon: 'none' });
      return;
    }
    if (!detail.code) {
      const denied = (detail.errMsg || '').indexOf('deny') >= 0 || (detail.errMsg || '').indexOf('auth deny') >= 0;
      wx.showToast({ title: denied ? '已取消授权' : '无法获取微信手机号', icon: 'none' });
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
      if (phone) this.setData({ phone });
      wx.showToast({ title: phone ? '手机号已绑定' : '已处理', icon: 'success' });
    } catch (err) {
      wx.showToast({
        title: (err && err.message) || '微信手机号不可用',
        icon: 'none',
      });
    } finally {
      this.setData({ phoneBinding: false });
    }
  },
  /** 选完微信头像/昵称后自动上传并 PATCH；昵称不附带临时头像，避免上传失败拖垮保存 */
  async persistProfile(partial) {
    if (this._profileSaveChain) {
      try { await this._profileSaveChain; } catch (e) { /* 串行下一次 */ }
    }
    const run = this._doPersistProfile(partial);
    this._profileSaveChain = run.finally(() => {
      if (this._profileSaveChain === run) this._profileSaveChain = null;
    });
    return run;
  },
  async _doPersistProfile(partial) {
    const nickname = partial.nickname != null
      ? String(partial.nickname).trim()
      : undefined;
    let avatarUrl = partial.avatarUrl != null
      ? partial.avatarUrl
      : undefined;
    // 只改昵称：绝不带上页面里可能残留的 wxfile 临时头像
    const uploadAvatarIfTemp = partial.avatarUrl != null;
    if (!uploadAvatarIfTemp) {
      avatarUrl = undefined;
    }
    if (!(nickname || avatarUrl)) return;
    this.setData({ profileSaving: true });
    try {
      const saved = await saveProfileWithAvatarUpload({
        nickname: nickname || undefined,
        avatarUrl: avatarUrl || undefined,
        uploadAvatarIfTemp,
      });
      const patch = {};
      const serverAvatar = stableMediaUrl(
        (saved.me && saved.me.avatarUrl) || saved.avatarUrl || '',
      ) || '';
      if (serverAvatar) {
        patch.avatarUrl = serverAvatar;
      } else if (isTempAvatarPath(this.data.avatarUrl)) {
        // 临时头像未上传成功：去掉 wxfile，避免下次误带；保留空以显示占位
        patch.avatarUrl = '';
      }
      if (saved.nickname != null) patch.nickname = saved.nickname;
      if (saved.phone != null) patch.phone = saved.phone;
      const nextNick = patch.nickname != null ? patch.nickname : (this.data.nickname || '');
      const nextAvatar = patch.avatarUrl != null ? patch.avatarUrl : (this.data.avatarUrl || '');
      patch.needProfileGuide = !nextNick || !nextAvatar || isTempAvatarPath(nextAvatar);
      this.setData(patch);
      if (saved.avatarUploadFailed && nickname) {
        wx.showToast({ title: '昵称已保存（头像待重选）', icon: 'none' });
      } else {
        wx.showToast({ title: '已保存', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ profileSaving: false });
    }
  },
  pickContactQr() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const path = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!path) return;
        try {
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
          const raw = upload.url || upload.publicUrl || upload.avatarUrl || '';
          const url = stableMediaUrl(raw) || raw;
          if (!url || isTempAvatarPath(url)) throw new Error('上传未返回可访问地址');
          await request({
            url: '/api/tenants/current/contact-qr',
            method: 'PATCH',
            data: { url },
          });
          this.setData({ contactQrUrl: url });
          wx.showToast({ title: '二维码已更新', icon: 'none' });
        } catch (e) {
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
  async createInvite() {
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const inv = await request({
        url: '/api/invites',
        method: 'POST',
        data: { role: 'staff', maxUses: 3, expiresInDays: 7 },
      });
      wx.hideLoading();
      this.setData({ latestInvite: inv });
      await this.load();
      wx.showToast({ title: '已生成，列表点邀请分享', icon: 'none' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '失败', icon: 'none' });
    }
  },
  /** 列表「邀请」：微信分享卡片；path 静默带 code，标题/UI 不展示邀请码 */
  onShareAppMessage(res) {
    let code = (this.data.latestInvite && this.data.latestInvite.code) || '';
    if (res && res.from === 'button' && res.target && res.target.dataset) {
      code = res.target.dataset.code || code;
    }
    code = String(code || '').trim().toUpperCase();
    const path = code
      ? `/pages/invite/accept/accept?code=${encodeURIComponent(code)}`
      : '/pages/invite/accept/accept';
    // 必须用公网 https；空/本地/坏链会导致分享卡中间大块黑
    const imageUrl = INVITE_SHARE_COVER_URL;
    return {
      title: '邀请你加入档口',
      path,
      imageUrl,
    };
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
  kickMember(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该员工';
    if (!id) return;
    wx.showModal({
      title: '踢除员工',
      content: `确定踢除「${name}」？踢后不能再以员工身份进入档口。`,
      confirmText: '踢除',
      confirmColor: '#ef4444',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request({ url: `/api/invites/members/${id}/disable`, method: 'POST' });
          this.load();
          wx.showToast({ title: '已踢除', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: (err && err.message) || '踢除失败', icon: 'none' });
        }
      },
    });
  },
});
