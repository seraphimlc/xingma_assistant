const { request } = require('../../../utils/request');
Page({
  data: {
    customer: null,
    id: '',
    levels: [],
    levelIndex: 0,
    followContent: '',
    followUps: [],
    inquiries: [],
    rules: [],
    ruleProductId: '',
    ruleEffect: 'allow',
  },
  onLoad(q) {
    this.setData({ id: q.id });
    this.loadLevels().then(() => this.load(q.id));
  },
  async loadLevels() {
    try {
      const levels = await request({ url: '/api/levels/customer' });
      this.setData({ levels: levels || [] });
    } catch (e) { /* ignore */ }
  },
  async load(id) {
    try {
      const customer = await request({ url: `/api/customers/${id}` });
      const levels = this.data.levels;
      let levelIndex = levels.findIndex((l) => l.id === customer.levelId);
      if (levelIndex < 0) levelIndex = 0;
      let inquiries = [];
      try {
        inquiries = await request({ url: `/api/inquiries?customerId=${encodeURIComponent(id)}` }) || [];
      } catch (e2) { inquiries = []; }
      this.setData({
        customer,
        followUps: customer.followUps || [],
        inquiries,
        rules: customer.rules || [],
        levelIndex,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  onLevelPick(e) {
    this.setData({ levelIndex: Number(e.detail.value) });
  },
  async saveLevel() {
    const level = this.data.levels[this.data.levelIndex];
    if (!level || !this.data.customer) return;
    try {
      const next = await request({
        url: `/api/customers/${this.data.customer.id}/level`,
        method: 'PATCH',
        data: { levelId: level.id },
      });
      this.setData({ customer: Object.assign({}, this.data.customer, next) });
      wx.showToast({ title: '等级已更新' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  onFollowInput(e) { this.setData({ followContent: e.detail.value }); },
  async addFollow() {
    if (!this.data.followContent.trim()) return;
    try {
      await request({
        url: `/api/customers/${this.data.id}/follow-ups`,
        method: 'POST',
        data: { content: this.data.followContent.trim() },
      });
      this.setData({ followContent: '' });
      this.load(this.data.id);
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
  onRuleProduct(e) { this.setData({ ruleProductId: e.detail.value }); },
  onRuleEffect(e) { this.setData({ ruleEffect: e.detail.value }); },
  async saveRule() {
    if (!this.data.ruleProductId.trim()) {
      wx.showToast({ title: '填写商品 ID', icon: 'none' });
      return;
    }
    try {
      await request({
        url: '/api/customers/rules',
        method: 'POST',
        data: {
          customerId: this.data.id,
          productId: this.data.ruleProductId.trim(),
          effect: this.data.ruleEffect,
        },
      });
      this.setData({ ruleProductId: '' });
      this.load(this.data.id);
      wx.showToast({ title: '规则已保存' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async removeRule(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({ url: `/api/customers/rules/${id}`, method: 'DELETE' });
      this.load(this.data.id);
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
});
