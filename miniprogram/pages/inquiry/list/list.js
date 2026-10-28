const { request } = require('../../../utils/request');

const PAGE_SIZE = 20;

function statusLabel(s) {
  if (s === 'handled') return '已处理';
  if (s === 'in_progress') return '正在沟通';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待沟通';
}

function normalize(i) {
  return Object.assign({}, i, {
    statusLabel: statusLabel(i.status),
    title: i.productName || i.productId || '询价',
    handlerText: (i.assigneeName || '').trim() || '未认领',
  });
}

Page({
  data: {
    list: [],
    status: 'open', // 默认待沟通
    statusChips: [
      { id: 'open', name: '待沟通' },
      { id: 'in_progress', name: '正在沟通' },
      { id: '', name: '全部' },
      { id: 'handled', name: '已处理' },
    ],
    page: 1,
    hasMore: true,
    loading: false,
    loadingMore: false,
  },
  onShow() { this.reload(); },
  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },
  onStatus(e) {
    this.setData({ status: e.currentTarget.dataset.id || '' });
    this.reload();
  },
  reload() {
    this.setData({ page: 1, hasMore: true, list: [] });
    return this.fetchPage(1, false);
  },
  loadMore() {
    return this.fetchPage(this.data.page + 1, true);
  },
  async fetchPage(page, append) {
    if (append) this.setData({ loadingMore: true });
    else this.setData({ loading: true });
    try {
      const qs = [`page=${page}`, `pageSize=${PAGE_SIZE}`];
      if (this.data.status) qs.push(`status=${encodeURIComponent(this.data.status)}`);
      const res = await request({ url: `/api/inquiries?${qs.join('&')}` });
      const raw = Array.isArray(res) ? res : (res.items || []);
      const total = Array.isArray(res) ? raw.length : (res.total != null ? res.total : raw.length);
      const items = (raw || []).map(normalize);
      const list = append ? this.data.list.concat(items) : items;
      this.setData({
        list,
        page,
        hasMore: list.length < total && items.length >= PAGE_SIZE,
        loading: false,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  goDetail(e) {
    wx.navigateTo({ url: `/pages/inquiry/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
