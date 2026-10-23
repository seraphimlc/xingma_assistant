const { request } = require('../../../utils/request');
function statusLabel(s) {
  if (s === 'handled') return '已处理';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待处理';
}
Page({
  data: { mode: '', productId: '', content: '', inquiry: null },
  onLoad(q) {
    if (q.mode === 'create') {
      this.setData({ mode: 'create', productId: q.productId || '' });
    } else if (q.id) {
      this.load(q.id);
    }
  },
  onContent(e) { this.setData({ content: e.detail.value }); },
  async submit() {
    try {
      const inquiry = await request({
        url: '/api/inquiries',
        method: 'POST',
        data: { productId: this.data.productId, content: this.data.content },
      });
      this.setData({ inquiry, mode: '' });
      wx.showToast({ title: '已提交' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async load(id) {
    try {
      const inquiry = await request({ url: `/api/inquiries/${id}` });
      this.setData({ inquiry: Object.assign({}, inquiry, { statusLabel: statusLabel(inquiry.status) }) });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
});
