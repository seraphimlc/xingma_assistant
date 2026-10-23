const { request } = require('./request');

const CONTACT_PROMPTED_KEY = 'contact_prompted_v1';

function currentRoute() {
  try {
    const pages = getCurrentPages();
    const cur = pages && pages.length ? pages[pages.length - 1] : null;
    return (cur && (cur.route || (cur.$page && cur.$page.fullPath))) || '';
  } catch (e) {
    return '';
  }
}

/** 是否已有可供客服联系的方式：手机 或 姓名/昵称 */
function hasContactInfo(me) {
  if (!me) return false;
  const phone = String(me.phone || '').trim();
  const name = String(me.nickname || '').trim();
  return !!(phone || name);
}

function isContactPrompted() {
  try {
    return !!wx.getStorageSync(CONTACT_PROMPTED_KEY);
  } catch (e) {
    return false;
  }
}

function markContactPrompted() {
  try {
    wx.setStorageSync(CONTACT_PROMPTED_KEY, '1');
  } catch (e) { /* ignore */ }
}

/** 微信 chooseAvatar 本地临时路径 */
function isTempAvatarPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (/^https?:\/\//i.test(u) && !/\/\/tmp\//i.test(u)) return false;
  return (
    /^wxfile:\/\//i.test(u) ||
    /^file:\/\//i.test(u) ||
    /^http:\/\/(tmp|usr)\//i.test(u) ||
    /^\/(tmp|usr)\//i.test(u) ||
    !/^https?:\/\//i.test(u)
  );
}

function uploadAvatar(filePath) {
  const app = getApp();
  const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
  const token = app.globalData.token || wx.getStorageSync('token') || '';
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: baseUrl + '/api/media/upload',
      filePath,
      name: 'file',
      header: { Authorization: token ? `Bearer ${token}` : '' },
      formData: { purpose: 'avatar' },
      success: (r) => {
        try {
          const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
          if (r.statusCode >= 200 && r.statusCode < 300) {
            const url = (data && (data.url || data.publicUrl || data.avatarUrl)) || '';
            if (!url) reject(new Error('上传未返回地址'));
            else resolve(url);
          } else {
            reject(new Error((data && data.message) || '头像上传失败'));
          }
        } catch (e) {
          reject(e);
        }
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '头像上传失败')),
    });
  });
}

/**
 * 客户分享落地 / 商品页：不弹「去设置」；联系方式由 view 页选填弹层处理。
 * 其它页：若缺资料仅可选引导设置（自愿），不强调手填头像昵称。
 */
function maybeCollectProfile(opts) {
  const app = getApp();
  const role = app.globalData.role || '';
  if (role !== 'customer' && role !== 'owner' && role !== 'staff') return Promise.resolve();
  if (wx.getStorageSync('profile_prompted_v1')) return Promise.resolve();
  const route = currentRoute();
  const onCustomerShareUi =
    /pages\/product\/view|pages\/share\/landing/.test(route) ||
    (opts && opts.allowNavigate === false);
  if (onCustomerShareUi) return Promise.resolve();
  return request({ url: '/api/auth/me' })
    .then((me) => {
      if (me && (hasContactInfo(me) || (me.nickname && (role !== 'customer' || me.avatarUrl)))) {
        wx.setStorageSync('profile_prompted_v1', '1');
        return;
      }
      // 员工自愿完善；客户主路径已在 view 弹联系方式，此处不再强推
      if (role === 'customer') {
        wx.setStorageSync('profile_prompted_v1', '1');
        return;
      }
      return new Promise((resolve) => {
        wx.showModal({
          title: '完善资料',
          content: '可自愿完善昵称（方便档口认出你），可跳过',
          confirmText: '去设置',
          cancelText: '跳过',
          success: (r) => {
            wx.setStorageSync('profile_prompted_v1', '1');
            if (!r.confirm) {
              resolve();
              return;
            }
            wx.navigateTo({
              url: '/pages/settings/index/index?profile=1',
              complete: () => resolve(),
              fail: () => resolve(),
            });
          },
          fail: () => resolve(),
        });
      });
    })
    .catch(() => {});
}

function saveProfile({ nickname, avatarUrl, phone }) {
  const data = {};
  if (nickname != null) data.nickname = nickname;
  if (avatarUrl != null) data.avatarUrl = avatarUrl;
  if (phone != null) data.phone = phone;
  return request({ url: '/api/auth/me', method: 'PATCH', data });
}

function saveProfileWithAvatarUpload({ nickname, avatarUrl, phone }) {
  const nick = nickname != null ? String(nickname).trim() : undefined;
  const ph = phone != null ? String(phone).trim() : undefined;
  let avatar = avatarUrl;
  const chain = isTempAvatarPath(avatar)
    ? uploadAvatar(avatar).then((url) => {
        avatar = url;
        return url;
      })
    : Promise.resolve(avatar);
  return chain.then(() =>
    saveProfile({
      nickname: nick !== undefined ? nick : undefined,
      avatarUrl: avatar != null ? avatar : undefined,
      phone: ph !== undefined ? ph : undefined,
    }).then((me) => ({ me, avatarUrl: avatar, nickname: nick, phone: ph })),
  );
}

/** 任务完成订阅：模板 ID 由后端/小程序后台配置；未配置则静默跳过 */
function requestJobSubscribe() {
  const tmplIds = [];
  try {
    const app = getApp();
    const fromApp = (app.globalData && app.globalData.subscribeTmplIds) || [];
    if (Array.isArray(fromApp)) tmplIds.push(...fromApp);
  } catch (e) { /* ignore */ }
  const cached = wx.getStorageSync('subscribe_tmpl_job') || '';
  if (cached) tmplIds.push(cached);
  const ids = [...new Set(tmplIds.filter(Boolean))].slice(0, 3);
  if (!ids.length) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => resolve(res),
      fail: (err) => resolve({ err }),
    });
  });
}

module.exports = {
  maybeCollectProfile,
  saveProfile,
  saveProfileWithAvatarUpload,
  uploadAvatar,
  isTempAvatarPath,
  hasContactInfo,
  isContactPrompted,
  markContactPrompted,
  CONTACT_PROMPTED_KEY,
  requestJobSubscribe,
};
