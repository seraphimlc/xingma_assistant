const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');
const { refreshCustomerTabBadge } = require('../../../utils/customer-tab-badge');

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
  // 行红点：有未读，或有询价记录
  const showDot = hasUnreadInquiry || inquiryCount > 0;
  return Object.assign({}, c, {
    displayName,
    contactLine,
    nickShort,
    inquiryCount,
    hasUnreadInquiry,
    showDot,
  });
}

Page({
  data: { list: [], q: '', loading: true },
  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    this.load();
    refreshCustomerTabBadge();
  },
  onPullDownRefresh() {
    Promise.all([this.load(), refreshCustomerTabBadge()]).finally(() => wx.stopPullDownRefresh());
  },
  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.load(); },
  async load() {
    this.setData({ loading: true });
    try {
      const qs = [];
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      const res = await request({ url: `/api/customers${qs.length ? '?' + qs.join('&') : ''}` });
      const raw = Array.isArray(res) ? res : (res.items || res || []);
      this.setData({ list: (raw || []).map(enrich), loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/customer/detail/detail?id=${id}` });
  },
});
