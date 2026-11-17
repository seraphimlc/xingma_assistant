/** 客户试衣：web-view 打开同域 H5。短票放在 H5 查询串，不把长期登录 JWT 放进 URL。 */
Page({
  data: { url: '' },
  onLoad(q) {
    const productId = (q && q.productId) || '';
    let ticket = (q && q.ticket) || '';
    if (!ticket && productId) {
      try {
        const saved = wx.getStorageSync('tryonLaunch') || {};
        const fresh = saved.at && Date.now() - saved.at < 10 * 60 * 1000;
        if (fresh && saved.productId === productId && saved.ticket) ticket = saved.ticket;
      } catch (e) { /* ignore */ }
    }
    if (!productId || !ticket) {
      this.setData({ url: '' });
      return;
    }
    const app = getApp();
    const base = String((app && app.globalData && app.globalData.baseUrl) || 'https://xingma.visitworld.me').replace(/\/$/, '');
    const url = `${base}/tryon/?productId=${encodeURIComponent(productId)}&ticket=${encodeURIComponent(ticket)}`;
    this.setData({ url });
    try { wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }); } catch (e) { /* */ }
  },
});
