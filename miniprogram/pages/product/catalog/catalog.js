/**
 * 客户目录：某分组下可公开展示（客户鉴权后可见）的在售商品。
 * 瀑布流双列；从分享落地的商品详情进入，携带 groupId + shareEventId。
 */
const { request, ensureSilentSession } = require('../../../utils/request');

const PAGE_SIZE = 20;

function normalize(p) {
  const priceText = p.priceText || '询价';
  const priceMuted = priceText === '未标价' || priceText === '询价' || priceText === '价格请询价';
  return Object.assign({}, p, {
    coverUrl: p.coverUrl || (p.images && p.images[0] && p.images[0].url) || '',
    priceText,
    priceMuted,
  });
}

/** 按累计高度把商品分到左右列（无高度时交替） */
function splitWaterfall(list, leftH, rightH) {
  const leftList = [];
  const rightList = [];
  let lh = leftH || 0;
  let rh = rightH || 0;
  (list || []).forEach((item, idx) => {
    const h = Number(item._h) || 0;
    if (lh <= rh) {
      leftList.push(item);
      lh += h || (idx % 2 === 0 ? 1 : 1.01);
    } else {
      rightList.push(item);
      rh += h || 1;
    }
  });
  return { leftList, rightList, leftH: lh, rightH: rh };
}

Page({
  data: {
    groupId: '',
    groupName: '',
    shareEventId: '',
    boundCustomerId: '',
    list: [],
    leftList: [],
    rightList: [],
    page: 1,
    hasMore: true,
    loading: false,
    loadingMore: false,
  },

  _leftH: 0,
  _rightH: 0,

  async onLoad(q) {
    const groupId = q.groupId || '';
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    const groupName = q.groupName ? decodeURIComponent(q.groupName) : '';
    this.setData({ groupId, shareEventId, boundCustomerId, groupName });
    try {
      if (!getApp().globalData.token) {
        await ensureSilentSession({ preferRole: 'customer' });
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '鉴权失败', icon: 'none' });
      return;
    }
    await this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },

  buildQs(page) {
    const qs = [`status=on_sale`, `publicOnly=1`, `page=${page}`, `pageSize=${PAGE_SIZE}`];
    if (this.data.groupId) qs.push(`groupId=${encodeURIComponent(this.data.groupId)}`);
    if (this.data.shareEventId) {
      qs.push(`shareEventId=${encodeURIComponent(this.data.shareEventId)}`);
    }
    if (this.data.boundCustomerId) {
      qs.push(`boundCustomerId=${encodeURIComponent(this.data.boundCustomerId)}`);
    }
    return qs.join('&');
  },

  applyList(list) {
    const { leftList, rightList } = splitWaterfall(list, 0, 0);
    this._leftH = 0;
    this._rightH = 0;
    this.setData({ list, leftList, rightList });
  },

  async reload() {
    this.setData({ loading: true, page: 1, hasMore: true, list: [], leftList: [], rightList: [] });
    this._leftH = 0;
    this._rightH = 0;
    try {
      const res = await request({ url: `/api/products?${this.buildQs(1)}` });
      const items = ((res && res.items) || []).map(normalize);
      const total = (res && res.total) != null ? res.total : items.length;
      this.applyList(items);
      this.setData({
        page: 1,
        hasMore: items.length < total && items.length >= PAGE_SIZE,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  async loadMore() {
    const next = this.data.page + 1;
    this.setData({ loadingMore: true });
    try {
      const res = await request({ url: `/api/products?${this.buildQs(next)}` });
      const items = ((res && res.items) || []).map(normalize);
      const list = this.data.list.concat(items);
      const total = (res && res.total) != null ? res.total : list.length;
      // 追加时在现有列高基础上继续分配
      const leftList = this.data.leftList.slice();
      const rightList = this.data.rightList.slice();
      let lh = this._leftH || 0;
      let rh = this._rightH || 0;
      // 若尚未量到高度，用当前列长度近似
      if (!lh && !rh) {
        lh = leftList.length;
        rh = rightList.length;
      }
      items.forEach((item) => {
        if (lh <= rh) {
          leftList.push(item);
          lh += 1;
        } else {
          rightList.push(item);
          rh += 1;
        }
      });
      this._leftH = lh;
      this._rightH = rh;
      this.setData({
        list,
        leftList,
        rightList,
        page: next,
        hasMore: list.length < total && items.length >= PAGE_SIZE,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
    }
  },

  onCoverLoad(e) {
    const id = e.currentTarget.dataset.id;
    const col = e.currentTarget.dataset.col;
    const h = (e.detail && e.detail.height) || 0;
    const w = (e.detail && e.detail.width) || 1;
    if (!id || !h) return;
    // 按列宽等比换算相对高度
    const rel = h / w;
    if (col === 'left') this._leftH = (this._leftH || 0) + rel;
    else this._rightH = (this._rightH || 0) + rel;
  },

  goProduct(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const qs = [`id=${id}`];
    if (this.data.shareEventId) qs.push(`shareEventId=${this.data.shareEventId}`);
    if (this.data.boundCustomerId) qs.push(`boundCustomerId=${this.data.boundCustomerId}`);
    wx.navigateTo({ url: `/pages/product/view/view?${qs.join('&')}` });
  },
});
