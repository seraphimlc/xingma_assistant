const { request } = require('../../../utils/request');
const { refreshCustomerTabBadge } = require('../../../utils/customer-tab-badge');

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(s) {
  if (s === 'handled') return '已处理';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待处理';
}

function enrichInquiry(i) {
  const contactSnap = [i.contactName, i.phone].filter(Boolean).join(' · ') || '';
  return Object.assign({}, i, {
    timeText: fmtTime(i.createdAt),
    statusLabel: statusLabel(i.status),
    isHandled: i.status === 'handled',
    productTitle: i.productName || i.productId || '商品',
    contactSnap,
    remarkText: i.remark || '',
    contentText: i.content || '',
  });
}

function enrichFollow(f) {
  return Object.assign({}, f, { timeText: fmtTime(f.createdAt) });
}

function enrichViewed(v) {
  const title = (v.productName || '').trim() || (v.styleNo ? `款号 ${v.styleNo}` : v.productId) || '商品';
  return Object.assign({}, v, {
    title,
    timeText: fmtTime(v.lastViewedAt),
    countText: v.viewCount > 1 ? `共 ${v.viewCount} 次` : '',
  });
}

function buildContact(customer) {
  if (!customer) return { name: '', phone: '', copyText: '', hasContact: false };
  const name = (customer.nickname || '').trim();
  const phone = (customer.phone || '').trim();
  const parts = [];
  if (name) parts.push(name);
  if (phone) parts.push(phone);
  return {
    name: name || '未留姓名',
    phone: phone || '未留手机',
    copyText: parts.join(' '),
    hasContact: parts.length > 0,
  };
}

Page({
  data: {
    customer: null,
    id: '',
    contact: { name: '', phone: '', copyText: '', hasContact: false },
    inquiries: [],
    viewedProducts: [],
    followUps: [],
    followContent: '',
    handleDrafts: {},
  },
  onLoad(q) {
    this.setData({ id: q.id || '' });
  },
  onShow() {
    if (this.data.id) this.load(this.data.id);
  },
  async load(id) {
    try {
      const customer = await request({ url: `/api/customers/${id}` });
      let inquiries = [];
      try {
        inquiries = (await request({ url: `/api/inquiries?customerId=${encodeURIComponent(id)}` })) || [];
      } catch (e2) {
        inquiries = [];
      }
      let viewedProducts = [];
      try {
        const vp = await request({ url: `/api/customers/${id}/viewed-products` });
        viewedProducts = (vp && vp.items) || [];
      } catch (e4) {
        viewedProducts = [];
      }
      try {
        await request({
          url: '/api/inquiries/mark-read',
          method: 'POST',
          data: { customerId: id },
        });
        refreshCustomerTabBadge();
      } catch (e3) { /* ignore */ }

      const contact = buildContact(customer);
      this.setData({
        customer,
        contact,
        followUps: (customer.followUps || []).map(enrichFollow),
        inquiries: (inquiries || []).map(enrichInquiry),
        viewedProducts: (viewedProducts || []).map(enrichViewed),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  copyContact() {
    const text = (this.data.contact && this.data.contact.copyText) || '';
    if (!text) {
      wx.showToast({ title: '暂无联系方式', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，可去微信联系' }),
    });
  },
  goProduct(e) {
    const pid = e.currentTarget.dataset.id;
    if (pid) wx.navigateTo({ url: `/pages/product/detail/detail?id=${pid}` });
  },
  onFollowInput(e) {
    this.setData({ followContent: e.detail.value });
  },
  async addFollow() {
    const content = (this.data.followContent || '').trim();
    if (!content) {
      wx.showToast({ title: '写一句跟进备忘', icon: 'none' });
      return;
    }
    try {
      await request({
        url: `/api/customers/${this.data.id}/follow-ups`,
        method: 'POST',
        data: { content, kind: 'note' },
      });
      this.setData({ followContent: '' });
      this.load(this.data.id);
      wx.showToast({ title: '已添加' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async removeFollow(e) {
    const fuId = e.currentTarget.dataset.id;
    try {
      await request({
        url: `/api/customers/${this.data.id}/follow-ups/${fuId}`,
        method: 'DELETE',
      });
      this.load(this.data.id);
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
  onHandleNoteInput(e) {
    const id = e.currentTarget.dataset.id;
    const drafts = Object.assign({}, this.data.handleDrafts);
    drafts[id] = e.detail.value;
    this.setData({ handleDrafts: drafts });
  },
  async markHandled(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const note = ((this.data.handleDrafts || {})[id] || '').trim();
    try {
      await request({
        url: `/api/inquiries/${id}/handled`,
        method: 'POST',
        data: { handledNote: note },
      });
      const drafts = Object.assign({}, this.data.handleDrafts);
      delete drafts[id];
      this.setData({ handleDrafts: drafts });
      this.load(this.data.id);
      wx.showToast({ title: '已标记处理' });
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
});
