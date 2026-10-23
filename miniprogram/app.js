/** 羊毛衫档口小程序入口 */
const publishQueue = require('./utils/publish-upload-queue');
const { refreshCustomerTabBadge } = require('./utils/customer-tab-badge');

App({
  globalData: {
    // 生产 API 基址（接口路径 /api/*）。需在小程序后台配置 request 合法域名 xingma.visitworld.me
    // 本地开发可临时改为 'http://127.0.0.1:3000'，并在开发者工具勾选「不校验合法域名」；
    // 后端设 DEV_FAKE_LOGIN=true 时，首页仅员工可用假登录；客户走分享落地静默鉴权
    baseUrl: 'https://xingma.visitworld.me',  // 真机联调：本机局域网 IP；上线改回 https://xingma.visitworld.me
    appId: 'wx394d23ea099d8a01',
    token: '',
    role: '', // owner | staff | customer
    tenantId: 'tenant_dev_001',
    userInfo: null,
    publishUpload: null,
  },
  onLaunch() {
    const token = wx.getStorageSync('token');
    const role = wx.getStorageSync('role');
    if (token) {
      this.globalData.token = token;
      this.globalData.role = role || '';
    }
    publishQueue.hydrate();
    publishQueue.resumeAll();
  },
  onShow() {
    // 锁屏/回前台：best-effort 续传 pending/failed
    try {
      publishQueue.resumeAll();
    } catch (e) { /* */ }
    // 员工：刷新客户 Tab 未读红点
    try {
      refreshCustomerTabBadge();
    } catch (e) { /* */ }
  },
  onHide() {
    try {
      const snap = publishQueue.getSnapshot();
      const n = publishQueue.pendingUploadCount(snap);
      if (n > 0 || (snap.running && snap.running.length)) {
        // 切后台无法可靠弹窗；依赖 enableAlertBeforeUnload + 浮窗
        console.warn('[publish-upload]', publishQueue.leaveWarnMessage(n));
      }
    } catch (e) { /* */ }
  },
  setSession(session) {
    this.globalData.token = session.token;
    this.globalData.role = session.role;
    this.globalData.tenantId = session.tenantId;
    wx.setStorageSync('token', session.token);
    wx.setStorageSync('role', session.role);
  },
});
