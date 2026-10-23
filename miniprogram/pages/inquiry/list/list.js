const { request } = require('../../../utils/request');

function statusLabel(s) {
  if (s === 'handled') return '已处理';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待处理';
}

Page({
  data: { list: [] },
  onShow() { this.load(); },
  async load() {
    try {
      const raw = await request({ url: '/api/inquiries' });
      const list = (raw || []).map((i) => Object.assign({}, i, {
        statusLabel: statusLabel(i.status),
        title: i.productName || i.productId || '询价',
      }));
      this.setData({ list });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  goDetail(e) {
    wx.navigateTo({ url: `/pages/inquiry/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
