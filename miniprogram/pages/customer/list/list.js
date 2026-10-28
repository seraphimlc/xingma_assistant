const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');
const { refreshCustomerTabBadge } = require('../../../utils/customer-tab-badge');

const PAGE_SIZE = 20;

function ensureStaff() {
  const app = getApp();
  const role = app.globalData.role || '';
  const token = app.globalData.token || '';
  if (!token || (role !== 'owner' && role !== 'staff')) {
    wx.reLaunch({ url: '/pages/index/index' });
    return false;
  }
  return true;
}

function enrich(c) {
  const nickname = (c.nickname || c.contactName || '').trim();
  const phone = (c.phone || '').trim();
  let displayName = nickname;
  if (!displayName && phone) displayName = phone;
  if (!displayName) displayName = '未留联系方式';
  const contactLine = [nickname, phone].filter(Boolean).join(' · ') || '未留联系方式';
  const nickShort = (nickname || phone || '客').slice(0, 1);
  const inquiryCount = c.inquiryCount || 0;
  const hasUnreadInquiry = !!c.hasUnreadInquiry;
  const pendingInquiryCount = Number(c.pendingInquiryCount || c.openInquiryCount || 0);
  const hasPendingInquiry = !!c.hasPendingInquiry || pendingInquiryCount > 0;
  // 行红点/徽章：仅未处理或未读；已处理不再显示
  const showDot = hasUnreadInquiry || hasPendingInquiry;
  const showInquiryBadge = hasUnreadInquiry || hasPendingInquiry;
  return Object.assign({}, c, {
    displayName,
    contactLine,
    nickShort,
    inquiryCount,
    hasUnreadInquiry,
    hasPendingInquiry,
    pendingInquiryCount,
    showDot,
    showInquiryBadge,
  });
}

Page({
  data: {
    list: [],
    q: '',
    loading: true,
    loadingMore: false,
    page: 1,
    hasMore: true,
    filter: '', // '' | pending
    filterChips: [
      { id: '', name: '全部' },
      { id: 'pending', name: '待处理' },
    ],
  },
  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    this.reload();
    refreshCustomerTabBadge();
  },
  onPullDownRefresh() {
    Promise.all([this.reload(), refreshCustomerTabBadge()]).finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },
  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.reload(); },
  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.id || '' });
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
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      if (this.data.filter === 'pending') qs.push('attention=pending');
      const res = await request({ url: `/api/customers?${qs.join('&')}` });
      // 兼容旧数组响应
      let raw = Array.isArray(res) ? res : (res.items || []);
      const total = Array.isArray(res) ? raw.length : (res.total != null ? res.total : raw.length);
      // 头像或昵称任一即可；两者皆无则不展示（与 API 一致；不去重）
      let items = (raw || []).map(enrich).filter((c) => {
        const avatar = (c.avatarUrl || '').trim();
        const nick = (c.nickname || c.contactName || '').trim();
        return !!(avatar || nick);
      });
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
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/customer/detail/detail?id=${id}` });
  },
});
