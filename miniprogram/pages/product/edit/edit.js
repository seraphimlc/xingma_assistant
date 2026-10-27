const { request } = require('../../../utils/request');

function buildDescription(sizeText, description) {
  const size = (sizeText || '').trim();
  let desc = (description || '').trim();
  desc = desc.replace(/^尺码[：:].+$/m, '').trim();
  if (size) desc = desc ? `尺码：${size}\n${desc}` : `尺码：${size}`;
  return desc || null;
}

function parseSizeFromDesc(description) {
  const m = (description || '').match(/尺码[：:]\s*(.+)/);
  return m ? m[1].trim() : '';
}

/** 从 suggestion.description 去掉已单独展示的尺码/颜色行，避免重复 */
function cleanDescFromSuggestion(s) {
  let desc = (s && s.description) || '';
  desc = desc
    .replace(/^尺码[：:].+$/m, '')
    .replace(/^颜色[：:].+$/m, '')
    .replace(/^克重[：:].+$/m, '')
    .trim();
  const weight = (s && s.weight) || '';
  if (weight && !desc.includes(weight)) {
    desc = desc ? `克重：${weight}\n${desc}` : `克重：${weight}`;
  }
  return desc;
}

Page({
  data: {
    id: '',
    // 新建：笔记流
    noteText: '',
    parsed: false,
    parsing: false,
    parseHint: '',
    // 商品字段
    styleNo: '',
    name: '',
    material: '',
    description: '',
    sizeText: '',
    levelId: '',
    priceDisplay: 'show',
    status: 'on_sale',
    skus: [{ color: '', price: '' }],
    productLevels: [],
    levelIndex: 0,
    levelRadios: [],
    groups: [],
    groupId: '',
    groupIndex: 0,
    images: [],
    saving: false,
    uploading: false,
    reordering: false,
    draggingIndex: -1,
    dragOverIndex: -1,
  },
  async onLoad(q) {
    await Promise.all([this.loadLevels(), this.loadGroups()]);
    if (q.id) {
      this.setData({ id: q.id, parsed: true });
      wx.setNavigationBarTitle({ title: '编辑商品' });
      await this.loadProduct(q.id);
    } else {
      wx.setNavigationBarTitle({ title: '手工发品' });
      // 新建默认进本季/最新分组
      const groups = this.data.groups || [];
      const latest = groups.find((g) => g.isLatest) || groups[0];
      if (latest) {
        this.setData({ groupId: latest.id, groupIndex: groups.indexOf(latest) });
      }
    }
  },
  async loadLevels() {
    try {
      const productLevels = await request({ url: '/api/levels/product' });
      const list = Array.isArray(productLevels) ? productLevels : (productLevels && productLevels.items) || [];
      const pick = (pred) => list.find(pred);
      const open = pick((l) => {
        const code = String((l && l.code) || '').toLowerCase();
        const id = String((l && l.id) || '');
        const name = String((l && l.name) || '');
        return code === 'open' || id === 'pl_open' || name === '公开款';
      });
      const directed = pick((l) => {
        const code = String((l && l.code) || '').toLowerCase();
        const id = String((l && l.id) || '');
        const name = String((l && l.name) || '');
        return code === 'directed' || code === 'designated' || id === 'pl_directed' || name === '定向款';
      });
      // 编辑页仅展示「公开款 / 定向款」单选；其它等级保留在 productLevels 兜底
      const levelRadios = [];
      if (open) levelRadios.push({ id: open.id, name: open.name || '公开款' });
      if (directed) levelRadios.push({ id: directed.id, name: directed.name || '定向款' });
      if (!levelRadios.length) {
        list.slice(0, 2).forEach((l) => levelRadios.push({ id: l.id, name: l.name || l.id }));
      }
      const fallback = open || levelRadios[0] || list[0];
      const levelId = this.data.levelId || (fallback && fallback.id) || '';
      let levelIndex = list.findIndex((l) => l.id === levelId);
      if (levelIndex < 0) levelIndex = 0;
      this.setData({
        productLevels: list,
        levelRadios,
        levelId: levelId || (list[0] && list[0].id) || '',
        levelIndex,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '等级加载失败', icon: 'none' });
    }
  },
  async loadGroups() {
    try {
      const res = await request({ url: '/api/product-groups' });
      const groups = (res && res.items) || [];
      let groupId = this.data.groupId;
      let groupIndex = groups.findIndex((g) => g.id === groupId);
      if (groupIndex < 0) {
        const latest = groups.find((g) => g.isLatest) || groups[0];
        groupId = latest ? latest.id : '';
        groupIndex = latest ? groups.indexOf(latest) : 0;
      }
      this.setData({ groups, groupId, groupIndex: Math.max(0, groupIndex) });
    } catch (e) {
      this.setData({ groups: [] });
    }
  },
  async loadProduct(id) {
    try {
      const p = await request({ url: `/api/products/${id}` });
      const levels = this.data.productLevels;
      let levelIndex = levels.findIndex((l) => l.id === p.levelId);
      if (levelIndex < 0) levelIndex = 0;
      const sizeText = parseSizeFromDesc(p.description);
      let description = p.description || '';
      description = description.replace(/^尺码[：:].+\n?/m, '').trim();
      const groups = this.data.groups || [];
      let groupIndex = groups.findIndex((g) => g.id === p.groupId);
      if (groupIndex < 0) {
        const latest = groups.find((g) => g.isLatest) || groups[0];
        groupIndex = latest ? groups.indexOf(latest) : 0;
      }
      const groupId = (groups[groupIndex] && groups[groupIndex].id) || p.groupId || '';
      this.setData({
        styleNo: p.styleNo || '',
        name: p.name || '',
        material: p.material || '',
        description,
        sizeText,
        levelId: p.levelId || '',
        groupId,
        groupIndex: Math.max(0, groupIndex),
        priceDisplay: p.priceDisplay || 'show',
        status: (p.status === 'on_sale' || p.status === 'off_sale') ? p.status : 'on_sale',
        skus: (p.skus && p.skus.length)
          ? p.skus.map((s) => ({
              id: s.id,
              color: s.color || '',
              price: s.price != null ? String(s.price) : '',
            }))
          : [{ color: '', price: '' }],
        levelIndex,
        images: (p.images || []).filter((im) => im && im.url),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onNoteInput(e) {
    this.setData({ noteText: e.detail.value });
  },
  clearNote() {
    this.setData({ noteText: '' });
  },
  backToNote() {
    this.setData({ parsed: false });
  },
  async parseNote() {
    if (this.data.parsing) return;
    const text = (this.data.noteText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴笔记文字', icon: 'none' });
      return;
    }
    this.setData({ parsing: true });
    try {
      const res = await request({
        url: '/api/products/parse-note',
        method: 'POST',
        data: { text },
      });
      const s = (res && res.suggestion) || res || {};
      const skus = (s.skus && s.skus.length)
        ? s.skus.map((row) => ({
            color: row.color || '',
            price: row.price != null && row.price !== '' ? String(row.price) : '',
          }))
        : (s.colors || []).map((c) => ({ color: c, price: s.defaultPrice ? String(s.defaultPrice) : '' }));
      if (!skus.length) skus.push({ color: '', price: '' });

      const sizeText = s.sizeText || parseSizeFromDesc(s.description) || '';
      this.setData({
        parsed: true,
        styleNo: s.styleNo || '',
        name: s.name || '',
        material: s.material || '',
        sizeText,
        description: cleanDescFromSuggestion(s),
        skus,
        parseHint: s.ocrNote || '已解析，可改后再保存',
      });
      if (!s.styleNo && !(s.colors && s.colors.length)) {
        wx.showToast({ title: '未识别到款号/颜色，请手改', icon: 'none' });
      } else {
        wx.showToast({ title: '已解析', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '解析失败', icon: 'none' });
    } finally {
      this.setData({ parsing: false });
    }
  },
  previewImage(e) {
    if (this._skipPreviewOnce) {
      this._skipPreviewOnce = false;
      return;
    }
    const images = this.data.images || [];
    const urls = images.map((im) => im && im.url).filter(Boolean);
    if (!urls.length) return;
    let idx = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= urls.length) {
      const url = e.currentTarget.dataset.url;
      idx = Math.max(0, urls.indexOf(url));
    }
    wx.previewImage({
      urls,
      current: urls[idx],
      fail: () => wx.showToast({ title: '无法预览图片', icon: 'none' }),
    });
  },
  addImages() {
    if (!this.data.id || this.data.uploading) return;
    const MAX = 60;
    const remain = MAX - (this.data.images || []).length;
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
        if (paths.length) this.uploadPaths(paths);
      },
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || '';
        if (/cancel/i.test(msg)) return;
        wx.chooseImage({
          count,
          success: (res) => {
            const paths = res.tempFilePaths || [];
            if (paths.length) this.uploadPaths(paths);
          },
        });
      },
    });
  },
  uploadPaths(paths) {
    const app = getApp();
    const baseUrl = app.globalData.baseUrl || '';
    const token = app.globalData.token || wx.getStorageSync('token') || '';
    const tenantId = app.globalData.tenantId || 'tenant_dev_001';
    const id = this.data.id;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中' });
    (async () => {
      try {
        for (const filePath of paths) {
          await new Promise((resolve, reject) => {
            wx.uploadFile({
              url: `${baseUrl}/api/products/${id}/images`,
              filePath,
              name: 'files',
              header: {
                Authorization: token ? `Bearer ${token}` : '',
                'X-Tenant-Id': tenantId,
                'X-Wx-Appid': app.globalData.appId || 'wx394d23ea099d8a01',
              },
              success: (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  try {
                    const body = JSON.parse(res.data);
                    if (body.images) this.setData({ images: body.images.filter((im) => im && im.url) });
                    resolve(body);
                  } catch (e) {
                    reject(new Error('上传响应解析失败'));
                  }
                } else {
                  let msg = `上传失败 ${res.statusCode}`;
                  try { msg = JSON.parse(res.data).message || msg; } catch (e) { /* */ }
                  reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
                }
              },
              fail: reject,
            });
          });
        }
        wx.hideLoading();
        wx.showToast({ title: `已添加 ${paths.length} 张`, icon: 'none' });
      } catch (e) {
        wx.hideLoading();
        const msg = (e && (e.message || e.errMsg)) || '上传失败';
        wx.showToast({ title: String(msg).slice(0, 40), icon: 'none', duration: 3000 });
      } finally {
        this.setData({ uploading: false });
      }
    })();
  },
  async removeImage(e) {
    const mediaId = e.currentTarget.dataset.id;
    if (!mediaId || !this.data.id) return;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '删除图片',
        content: '确定从商品中删除这张图？',
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    try {
      const p = await request({
        url: `/api/products/${this.data.id}/images/${mediaId}`,
        method: 'DELETE',
        data: {},
      });
      this.setData({ images: (p.images || []).filter((im) => im && im.url) });
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },
  onStyle(e) { this.setData({ styleNo: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onMaterial(e) { this.setData({ material: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onSizeText(e) { this.setData({ sizeText: e.detail.value }); },
  onStatusTap(e) {
    const v = e.currentTarget.dataset.v;
    if (v !== 'on_sale' && v !== 'off_sale') return;
    this.setData({ status: v });
  },
  onPriceDisplayTap(e) { this.setData({ priceDisplay: e.currentTarget.dataset.v }); },
  onLevelChange(e) {
    const idx = Number(e.detail.value);
    const level = this.data.productLevels[idx];
    this.setData({ levelIndex: idx, levelId: level ? level.id : '' });
  },
  onLevelTap(e) {
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;
    const list = this.data.productLevels || [];
    let levelIndex = list.findIndex((l) => l.id === id);
    if (levelIndex < 0) levelIndex = 0;
    this.setData({ levelId: id, levelIndex });
  },
  onGroupChange(e) {
    const idx = Number(e.detail.value);
    const group = this.data.groups[idx];
    this.setData({ groupIndex: idx, groupId: group ? group.id : '' });
  },
  onSkusChange(e) {
    this.setData({ skus: e.detail.skus || [] });
  },
  _refreshCellRects(cb) {
    wx.createSelectorQuery()
      .in(this)
      .selectAll('.img-cell.sortable')
      .boundingClientRect((rects) => {
        this._cellRects = Array.isArray(rects) ? rects : [];
        if (typeof cb === 'function') cb(this._cellRects);
      })
      .exec();
  },
  _hitCellIndex(clientX, clientY) {
    const rects = this._cellRects || [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return i;
    }
    // 容错：按最近中心点（拖出格外时仍能落到最近格）
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const d = (clientX - cx) * (clientX - cx) + (clientY - cy) * (clientY - cy);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  },
  onImgTouchStart(e) {
    // 提前量测格子；拖动过程中不改 images 数组，避免 wx:key 重排打断 touch
    if (this.data.reordering || !this.data.id) return;
    this._touchStartIndex = Number(e.currentTarget.dataset.index);
    this._refreshCellRects();
  },
  onImgLongPress(e) {
    if (this.data.reordering || !this.data.id) return;
    const index = Number(e.currentTarget.dataset.index);
    const id = e.currentTarget.dataset.id;
    if (!id || Number.isNaN(index) || index < 0) return;
    this._drag = { active: true, from: index, over: index, id, moved: false };
    this.setData({ draggingIndex: index, dragOverIndex: index });
    try { wx.vibrateShort({ type: 'medium' }); } catch (err) { /* */ }
    this._refreshCellRects();
  },
  onImgTouchMove(e) {
    if (!this._drag || !this._drag.active) return;
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    this._drag.moved = true;
    if (!(this._cellRects && this._cellRects.length)) {
      this._refreshCellRects();
      return;
    }
    const over = this._hitCellIndex(t.clientX, t.clientY);
    if (over < 0 || over === this._drag.over) return;
    this._drag.over = over;
    // 只高亮目标格，不 splice images（重排会丢 touch / 来回抖）
    if (over !== this.data.dragOverIndex) this.setData({ dragOverIndex: over });
  },
  onImgTouchEnd() {
    if (!this._drag || !this._drag.active) return;
    const from = this._drag.from;
    const to = this._drag.over;
    const moved = this._drag.moved;
    this._drag = null;
    this._cellRects = null;
    this.setData({ draggingIndex: -1, dragOverIndex: -1 });
    if (moved) this._skipPreviewOnce = true;
    if (moved && from >= 0 && to >= 0 && from !== to) {
      this.reorderImages(from, to);
    }
  },
  async persistImageOrder() {
    if (this.data.reordering || !this.data.id) return;
    const images = this.data.images || [];
    const coverMediaIds = images.map((im) => im && im.id).filter(Boolean);
    if (!coverMediaIds.length) return;
    this.setData({ reordering: true });
    try {
      await request({
        url: `/api/products/${this.data.id}`,
        method: 'PATCH',
        data: { coverMediaIds },
      });
      wx.showToast({ title: '顺序已保存', icon: 'success', duration: 800 });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '调序失败', icon: 'none' });
      await this.loadProduct(this.data.id);
    } finally {
      this.setData({ reordering: false });
    }
  },
  async reorderImages(from, to) {
    if (this.data.reordering || !this.data.id) return;
    const images = (this.data.images || []).slice();
    if (from < 0 || to < 0 || from >= images.length || to >= images.length || from === to) return;
    const [item] = images.splice(from, 1);
    images.splice(to, 0, item);
    this.setData({ images });
    await this.persistImageOrder();
  },
  buildPayload() {
    const skus = (this.data.skus || [])
      .filter((s) => (s.color || '').trim())
      .map((s) => ({
        color: s.color.trim(),
        size: null,
        price: (s.price || '').trim() || null,
        stock: 0,
        status: 'active',
      }));
    return {
      styleNo: this.data.styleNo.trim(),
      name: this.data.name.trim(),
      material: this.data.material.trim() || null,
      description: buildDescription(this.data.sizeText, this.data.description),
      levelId: this.data.levelId,
      groupId: this.data.groupId || null,
      priceDisplay: this.data.priceDisplay,
      status: this.data.status,
      skus,
    };
  },
  async save() {
    if (this.data.saving) return;
    if (!this.data.id && !this.data.parsed) {
      wx.showToast({ title: '请先解析笔记', icon: 'none' });
      return;
    }
    const payload = this.buildPayload();
    if (!payload.styleNo || !payload.name || !payload.levelId) {
      wx.showToast({ title: '请填款号、名称', icon: 'none' });
      return;
    }
    if (!payload.skus.length) {
      wx.showToast({ title: '请至少填写一个颜色', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      if (this.data.id) {
        const { skus, ...rest } = payload;
        rest.coverMediaIds = (this.data.images || []).map((im) => im.id).filter(Boolean);
        await request({ url: `/api/products/${this.data.id}`, method: 'PATCH', data: rest });
        // 整体 upsert，勿 DELETE+POST（软删占 uk_sku 会 Duplicate entry）
        await request({
          url: `/api/products/${this.data.id}/skus`,
          method: 'PUT',
          data: { skus },
        });
      } else {
        await request({ url: '/api/products', method: 'POST', data: payload });
      }
      wx.showToast({ title: '已保存' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
