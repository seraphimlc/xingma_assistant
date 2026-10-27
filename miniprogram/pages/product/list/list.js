const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');

const PAGE_SIZE = 10;

function shortMaterial(m) {
  if (!m) return '';
  const s = String(m).replace(/\s+/g, ' ').trim();
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

function normalizeItem(p) {
  const colorCount = p.colorCount != null
    ? p.colorCount
    : ((p.skus && p.skus.length) || 0);
  const priceText = p.priceText || '未标价';
  const priceMuted = priceText === '未标价' || priceText === '询价' || priceText === '价格请询价';
  return Object.assign({}, p, {
    coverUrl: p.coverUrl || (p.images && p.images[0] && p.images[0].url) || '',
    colorCount,
    materialShort: shortMaterial(p.material),
    priceText,
    priceMuted,
  });
}

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

function promptText(title, placeholder, initial) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      editable: true,
      placeholderText: placeholder || '',
      content: initial || '',
      success: (r) => {
        if (!r.confirm) return resolve(null);
        resolve(String(r.content || '').trim());
      },
      fail: () => resolve(null),
    });
  });
}

function confirmModal(title, content) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

function actionSheet(itemList) {
  return new Promise((resolve) => {
    if (!itemList || !itemList.length) {
      resolve(-1);
      return;
    }
    wx.showActionSheet({
      itemList,
      success: (r) => resolve(r.tapIndex),
      fail: () => resolve(-1),
    });
  });
}

Page({
  data: {
    list: [],
    isStaff: false,
    q: '',
    status: 'on_sale',
    groupId: '',
    groups: [],
    currentGroupName: '本季款式',
    statusLabel: { on_sale: '在售', off_sale: '下架' },
    page: 1,
    total: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    groupPanelVisible: false,
    groupPanelMode: 'manage',
    moveProductId: '',
    shareSheetVisible: false,
    shareSheetProduct: { id: '', name: '', styleNo: '', coverUrl: '' },
  },

  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    const app = getApp();
    this.setData({ isStaff: true, role: app.globalData.role });
    this.loadGroups().then(() => this.reload());
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },

  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.reload(); },
  onStatusFilter(e) {
    const raw = e.currentTarget.dataset.status;
    // 全部: empty string (API omits status). Keep default 在售.
    const s = raw == null || raw === 'all' ? '' : String(raw);
    if (s !== '' && s !== 'on_sale' && s !== 'off_sale') return;
    if (s === this.data.status) return;
    this.setData({ status: s });
    this.reload();
  },
  onGroupFilter(e) {
    const id = e.currentTarget.dataset.id || '';
    const g = (this.data.groups || []).find((x) => x.id === id);
    this.setData({
      groupId: id,
      currentGroupName: (g && g.name) || '全部',
    });
    this.reload();
  },

  async loadGroups() {
    try {
      const res = await request({ url: '/api/product-groups' });
      const groups = (res && res.items) || [];
      let groupId = this.data.groupId;
      const stillThere = groupId && groups.some((g) => g.id === groupId);
      if (!groupId || !stillThere) {
        const latest = groups.find((g) => g.isLatest) || groups[0];
        groupId = latest ? latest.id : '';
      }
      const cur = groups.find((g) => g.id === groupId);
      this.setData({
        groups,
        groupId,
        currentGroupName: (cur && cur.name) || '本季款式',
      });
      return groups;
    } catch (e) {
      return this.data.groups || [];
    }
  },

  async afterGroupChange(needReloadList) {
    const prevId = this.data.groupId;
    await this.loadGroups();
    if (needReloadList || this.data.groupId !== prevId) {
      await this.reload();
    }
  },

  manageGroups() {
    this.setData({
      groupPanelVisible: true,
      groupPanelMode: 'manage',
      moveProductId: '',
    });
  },

  closeGroupPanel() {
    this.setData({
      groupPanelVisible: false,
      moveProductId: '',
    });
  },

  noop() {},

  async onGroupPanelRowTap(e) {
    const id = e.currentTarget.dataset.id;
    const group = (this.data.groups || []).find((g) => g.id === id);
    if (!group) return;
    await this.manageOneGroup(group);
  },

  async createGroup() {
    const name = await promptText('新建分组', '例如：春季新款');
    if (name == null) return;
    if (!name) {
      wx.showToast({ title: '请输入分组名称', icon: 'none' });
      return;
    }
    try {
      await request({
        url: '/api/product-groups',
        method: 'POST',
        data: { name, isLatest: true },
      });
      wx.showToast({ title: '已创建', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '创建失败', icon: 'none' });
    }
  },

  async manageOneGroup(group) {
    const actions = ['改名'];
    if (!group.isLatest) actions.push('设为本季');
    actions.push('删除');
    const tap = await actionSheet(actions);
    if (tap < 0) return;
    const action = actions[tap];
    if (action === '改名') {
      await this.renameGroup(group);
    } else if (action === '设为本季') {
      await this.setLatestGroup(group);
    } else if (action === '删除') {
      await this.deleteGroup(group);
    }
  },

  async renameGroup(group) {
    const name = await promptText('改名', '分组名称', group.name);
    if (name == null) return;
    if (!name) {
      wx.showToast({ title: '请输入分组名称', icon: 'none' });
      return;
    }
    if (name === group.name) return;
    try {
      await request({
        url: `/api/product-groups/${group.id}`,
        method: 'PATCH',
        data: { name },
      });
      wx.showToast({ title: '已改名', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '改名失败', icon: 'none' });
    }
  },

  async setLatestGroup(group) {
    try {
      await request({
        url: `/api/product-groups/${group.id}/latest`,
        method: 'PATCH',
      });
      wx.showToast({ title: '已设为本季', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '设置失败', icon: 'none' });
    }
  },

  async deleteGroup(group) {
    const ok = await confirmModal(
      '删除分组',
      `确定删除「${group.name}」？组内须先无商品。`,
    );
    if (!ok) return;
    try {
      await request({
        url: `/api/product-groups/${group.id}`,
        method: 'DELETE',
      });
      wx.showToast({ title: '已删除', icon: 'success' });
      await this.afterGroupChange(true);
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },


  reload() {
    this.setData({ page: 1, hasMore: true, list: [] });
    return this.fetchPage(1, false);
  },

  loadMore() {
    const next = this.data.page + 1;
    return this.fetchPage(next, true);
  },

  async fetchPage(page, append) {
    if (append) this.setData({ loadingMore: true });
    else this.setData({ loading: true });
    try {
      const qs = [
        `page=${page}`,
        `pageSize=${PAGE_SIZE}`,
      ];
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      if (this.data.status) qs.push(`status=${this.data.status}`);
      if (this.data.groupId) qs.push(`groupId=${this.data.groupId}`);
      const res = await request({ url: `/api/products?${qs.join('&')}` });
      const raw = Array.isArray(res) ? res : (res.items || []);
      const total = Array.isArray(res) ? raw.length : (res.total != null ? res.total : raw.length);
      const items = raw.map(normalizeItem);
      const list = append ? this.data.list.concat(items) : items;
      const hasMore = list.length < total && items.length >= PAGE_SIZE;
      this.setData({
        list,
        total,
        page,
        hasMore,
        loading: false,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/product/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
  /** 宣传素材（下载/保存）：与分享解耦，直达素材库 */
  goMaterials(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/product/promo-gallery/promo-gallery?id=${id}` });
  },
  /** 列表「转发」→ 公开 / 限量（与详情页策略对齐，不进详情） */
  openShareSheet(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const id = ds.id || '';
    if (!id) return;
    const product = {
      id,
      name: ds.name || '',
      styleNo: ds.style || '',
      coverUrl: ds.cover || '',
    };
    this._shareTarget = product;
    this._sharePolicy = 'open';
    this.setData({ shareSheetVisible: true, shareSheetProduct: product });
    // 预热两种策略
    this._prefetchShare(id, 'open').catch(() => {});
    this._prefetchShare(id, 'limited').catch(() => {});
  },
  closeShareSheet() {
    this.setData({ shareSheetVisible: false });
  },
  onShareSheetTap(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const policy = ds.policy === 'limited' ? 'limited' : 'open';
    this._sharePolicy = policy;
    const p = this.data.shareSheetProduct || this._shareTarget || {};
    if (p.id) {
      this._shareTarget = p;
      this._prefetchShare(p.id, policy).catch(() => {});
    }
  },
  async _prefetchShare(productId, mode) {
    if (!productId) return null;
    const m = mode === 'limited' ? 'limited' : 'open';
    const policy = m === 'limited' ? 'designated_only' : 'open';
    if (!this._shareCache) this._shareCache = {};
    const key = `${productId}::${m}`;
    if (this._shareCache[key] && this._shareCache[key].shareId) {
      return this._shareCache[key];
    }
    const data = { productId, sharePolicy: policy };
    const res = await request({
      url: '/api/shares',
      method: 'POST',
      data,
    });
    this._shareCache[key] = res;
    return res;
  },
  onShareAppMessage() {
    const tgt = this._shareTarget || this.data.shareSheetProduct || {};
    const productId = tgt.id || '';
    const mode = this._sharePolicy === 'limited' ? 'limited' : 'open';
    const title = (tgt.name || tgt.styleNo || '商品分享').trim();
    const imageUrl = tgt.coverUrl || '';
    const fallback = productId
      ? `/pages/share/landing/landing?productId=${productId}`
      : '/pages/share/landing/landing';
    const key = productId ? `${productId}::${mode}` : '';
    const cached = key && this._shareCache && this._shareCache[key];
    const syncPath = (cached && cached.shareId)
      ? `/pages/share/landing/landing?shareId=${cached.shareId}`
      : fallback;
    // 发出后收起面板
    setTimeout(() => {
      try { this.setData({ shareSheetVisible: false }); } catch (e) { /* */ }
    }, 400);
    if (!productId) {
      return { title: '商品分享', path: fallback };
    }
    return {
      title,
      path: syncPath,
      imageUrl: imageUrl || undefined,
      promise: this._prefetchShare(productId, mode)
        .then((shareRes) => {
          const sid = shareRes && shareRes.shareId;
          return {
            title,
            path: sid
              ? `/pages/share/landing/landing?shareId=${sid}`
              : ((shareRes && shareRes.path) || fallback),
            imageUrl: imageUrl || undefined,
          };
        })
        .catch(() => ({ title, path: fallback, imageUrl: imageUrl || undefined })),
    };
  },
  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: id ? `/pages/product/edit/edit?id=${id}` : '/pages/product/edit/edit',
    });
  },
  goPublish() {
    wx.navigateTo({ url: '/pages/product/publish/publish' });
  },
});
