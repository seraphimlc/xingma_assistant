const { request } = require('../../../utils/request');
const { startPublishUpload, getSnapshot, syncLeaveGuard, pendingUploadCount, leaveWarnMessage } = require('../../../utils/publish-upload-queue');

const ROLE_ORDER = ['hangtag', 'main', 'detail', 'multi_color', 'on_model', 'packaging', 'size_chart', 'lab_report', 'unknown'];
const ROLE_LABEL = {
  hangtag: '吊牌/标签',
  main: '挂拍/平铺',
  detail: '细节',
  multi_color: '色卡/多色',
  on_model: '上身效果',
  packaging: '包装/袋装',
  size_chart: '尺码表',
  lab_report: '检测报告',
  unknown: '未识别',
};

function pickLevel(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return null;
  const open = arr.find((l) => {
    const code = String((l && l.code) || '').toLowerCase();
    const id = String((l && l.id) || '');
    return code === 'open' || id === 'pl_open';
  });
  return open || arr[0];
}

function pickLatestGroup(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return null;
  return arr.find((g) => g && g.isLatest) || arr[0];
}

Page({
  data: {
    step: 1,
    localPaths: [],
    batchId: '',
    images: [],
    styleNo: '',
    name: '',
    material: '',
    sizeText: '',
    description: '',
    skus: [{ color: '', price: '' }],
    status: 'on_sale',
    levelId: '',
    groupId: '',
    ocrNote: '',
    roleLabel: ROLE_LABEL,
    submitting: false,
    runningHint: '',
  },
  async onLoad() {
    try {
      await this.ensurePublishMeta({ silent: true });
    } catch (e) {
      /* 发品时再拉一次 */
    }
  },
  onShow() {
    const snap = getSnapshot();
    const n = (snap.running || []).length;
    this.setData({
      runningHint: n ? `后台已有 ${n} 批上传中，可再开新一批` : '',
    });
    syncLeaveGuard(snap);
  },
  onHide() {
    syncLeaveGuard(getSnapshot());
  },

  /**
   * 确保有可用 levelId + 本季/最新 groupId。
   * 等级为空时自动创建「公开款」；分组为空时提示去商品列表「管理」新建。
   */
  async ensurePublishMeta(opts) {
    const silent = !!(opts && opts.silent);
    let levels = [];
    try {
      const raw = await request({ url: '/api/levels/product' });
      levels = Array.isArray(raw) ? raw : (raw && raw.items) || [];
    } catch (e) {
      if (!silent) throw e;
      levels = [];
    }

    let level = pickLevel(levels);
    if (!level) {
      try {
        level = await request({
          url: '/api/levels/product',
          method: 'POST',
          data: {
            code: 'OPEN',
            name: '公开款',
            rank: 0,
            defaultSharePolicy: 'open',
            minCustomerRank: null,
          },
        });
      } catch (e) {
        // 可能并发已创建：再拉一次
        const raw2 = await request({ url: '/api/levels/product' }).catch(() => []);
        const list2 = Array.isArray(raw2) ? raw2 : (raw2 && raw2.items) || [];
        level = pickLevel(list2);
        if (!level) {
          throw new Error('无商品等级，请到「设置」添加商品等级后再发品');
        }
      }
    }

    let group = null;
    try {
      const gres = await request({ url: '/api/product-groups' });
      const items = (gres && gres.items) || [];
      group = pickLatestGroup(items);
    } catch (e) {
      group = null;
    }
    if (!group) {
      throw new Error('暂无商品分组，请到商品列表点「管理」新建分组（如本季款式）');
    }

    this.setData({
      levelId: level.id,
      groupId: group.id,
      status: 'on_sale',
    });
    return { levelId: level.id, groupId: group.id };
  },

  chooseImages() {
    const MAX = 60;
    const have = (this.data.localPaths || []).length;
    const remain = MAX - have;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX} 张`, icon: 'none' });
      return;
    }
    const count = Math.min(9, remain);
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        if (!paths.length) return;
        this.setData({ localPaths: this.data.localPaths.concat(paths).slice(0, MAX) });
      },
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || '';
        if (/cancel/i.test(msg)) return;
        wx.chooseImage({
          count,
          success: (res) => {
            const paths = res.tempFilePaths || [];
            if (!paths.length) return;
            this.setData({ localPaths: this.data.localPaths.concat(paths).slice(0, MAX) });
          },
        });
      },
    });
  },
  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) return;
    const localPaths = this.data.localPaths.slice();
    localPaths.splice(index, 1);
    this.setData({ localPaths });
  },
  /**
   * 立刻把任务丢进全局队列并离开本页；上传在后台跑（浮窗看进度）。
   * 可与已有上传任务并发（多 batch）。
   */
  async uploadAndPublish() {
    if (this.data.submitting || !this.data.localPaths.length) return;
    this.setData({ submitting: true });
    try {
      const meta = await this.ensurePublishMeta({ silent: false });
      const paths = this.data.localPaths.slice();
      await startPublishUpload({
        localPaths: paths,
        levelId: meta.levelId,
        groupId: meta.groupId,
        status: 'on_sale',
        priceDisplay: 'show',
      });
      this.setData({ localPaths: [], submitting: false });
      wx.showToast({ title: '已开始上传', icon: 'success', duration: 1200 });
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/product/list/list',
          fail: () => {
            wx.navigateBack({ fail: () => {} });
          },
        });
      }, 200);
    } catch (e) {
      this.setData({ submitting: false });
      wx.showToast({
        title: String((e && e.message) || e).slice(0, 40),
        icon: 'none',
        duration: 2800,
      });
    }
  },
  backToSelect() {
    this.setData({
      step: 1,
      localPaths: [],
      batchId: '',
      images: [],
    });
  },
  cycleRole(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    const cur = images[index].role;
    const i = ROLE_ORDER.indexOf(cur);
    images[index] = { ...images[index], role: ROLE_ORDER[(i + 1) % ROLE_ORDER.length] };
    this.setData({ images });
  },
  onStyle(e) { this.setData({ styleNo: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onMaterial(e) { this.setData({ material: e.detail.value }); },
  onSizeText(e) { this.setData({ sizeText: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onSkusChange(e) { this.setData({ skus: e.detail.skus || [] }); },
  /** 保留旧 confirm（step2 人工确认）；主按钮已走异步建品 */
  async confirmPublish() {
    if (this.data.saving) return;
    const styleNo = this.data.styleNo.trim();
    const name = this.data.name.trim();
    if (!styleNo || !name) {
      wx.showToast({ title: '请填款号和名称', icon: 'none' });
      return;
    }
    let meta;
    try {
      meta = await this.ensurePublishMeta({ silent: false });
    } catch (e) {
      wx.showToast({ title: String((e && e.message) || e).slice(0, 40), icon: 'none' });
      return;
    }
    const skus = (this.data.skus || [])
      .filter((s) => (s.color || '').trim())
      .map((s) => ({ color: s.color.trim(), price: (s.price || '').trim() || null }));
    if (!skus.length) {
      wx.showToast({ title: '请至少保留一个颜色', icon: 'none' });
      return;
    }
    let description = (this.data.description || '').trim();
    const sizeText = (this.data.sizeText || '').trim();
    if (sizeText) {
      description = description ? `尺码：${sizeText}\n${description}` : `尺码：${sizeText}`;
    }
    this.setData({ saving: true });
    try {
      const product = await request({
        url: '/api/products/publish/confirm',
        method: 'POST',
        data: {
          batchId: this.data.batchId,
          styleNo,
          name,
          material: this.data.material.trim() || null,
          description: description || null,
          levelId: meta.levelId,
          groupId: meta.groupId,
          status: 'on_sale',
          skus,
          images: this.data.images.map((im) => ({
            mediaId: im.mediaId,
            role: im.role,
            colorHint: im.colorHint || null,
          })),
        },
      });
      wx.showToast({ title: '发品成功' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/product/edit/edit?id=${product.id}` });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || '发品失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
