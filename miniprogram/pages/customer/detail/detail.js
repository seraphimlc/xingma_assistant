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
  if (s === 'in_progress') return '正在沟通';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待沟通';
}

function statusClass(s) {
  if (s === 'handled' || s === 'replied' || s === 'closed') return 'done';
  if (s === 'in_progress') return 'progress';
  return 'open';
}

function enrichInquiry(i) {
  const st = i.status || 'open';
  return Object.assign({}, i, {
    timeText: fmtTime(i.createdAt),
    statusLabel: statusLabel(st),
    statusClass: statusClass(st),
    isHandled: st === 'handled',
    isOpen: st === 'open' || st === 'pending',
    isInProgress: st === 'in_progress',
    handlerText: (i.assigneeName || '').trim() || '未认领',
    productTitle: i.productName || i.productId || '商品',
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
  return {
    name: name || '未留姓名',
    phone: phone || '未留手机',
    copyText: phone,
    hasContact: !!phone,
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
      const [customerRes, inquiriesRes, viewedRes] = await Promise.all([
        request({ url: `/api/customers/${id}` }),
        request({
          url: `/api/inquiries?customerId=${encodeURIComponent(id)}&page=1&pageSize=50`,
        }).catch(() => ({ items: [] })),
        request({ url: `/api/customers/${id}/viewed-products` }).catch(() => ({ items: [] })),
      ]);
      const customer = customerRes;
      const inquiries = Array.isArray(inquiriesRes)
        ? inquiriesRes
        : (inquiriesRes && inquiriesRes.items) || [];
      const viewedProducts = (viewedRes && viewedRes.items) || [];
      // mark-read 不挡首屏
      request({
        url: '/api/inquiries/mark-read',
        method: 'POST',
        data: { customerId: id },
      }).then(() => refreshCustomerTabBadge()).catch(() => {});

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
  async claimInquiry(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._inqBusy) return;
    this._inqBusy = true;
    try {
      await request({
        url: `/api/inquiries/${id}/claim`,
        method: 'POST',
        data: {},
      });
      await this.load(this.data.id);
      try { await refreshCustomerTabBadge(); } catch (e2) { /* */ }
      wx.showToast({ title: '已接单沟通' });
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    } finally {
      this._inqBusy = false;
    }
  },
  async markHandled(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._inqBusy) return;
    const note = ((this.data.handleDrafts || {})[id] || '').trim();
    if (!note) {
      wx.showToast({ title: '请填写沟通内容', icon: 'none' });
      return;
    }
    this._inqBusy = true;
    try {
      await request({
        url: `/api/inquiries/${id}/handled`,
        method: 'POST',
        data: { handledNote: note },
      });
      const drafts = Object.assign({}, this.data.handleDrafts);
      delete drafts[id];
      this.setData({ handleDrafts: drafts });
      await this.load(this.data.id);
      try { await refreshCustomerTabBadge(); } catch (e2) { /* */ }
      wx.showToast({ title: '沟通完成' });
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    } finally {
      this._inqBusy = false;
    }
  },
});
