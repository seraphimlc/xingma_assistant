/** 客户 Tab 红点：有未读询价时 showTabBarRedDot，否则 hide */
const { request } = require('./request');

const CUSTOMER_TAB_INDEX = 1; // app.json tabBar: 商品0 / 客户1 / 任务2

async function refreshCustomerTabBadge() {
  const app = getApp();
  const role = (app && app.globalData && app.globalData.role) || '';
  const token = (app && app.globalData && app.globalData.token) || '';
  if (!token || (role !== 'owner' && role !== 'staff')) {
    try { wx.hideTabBarRedDot({ index: CUSTOMER_TAB_INDEX }); } catch (e) { /* */ }
    return { unreadInquiryCount: 0, customers: [] };
  }
  try {
    const summary = await request({ url: '/api/inquiries/unread-summary' });
    const n = (summary && summary.unreadInquiryCount) || 0;
    if (n > 0) {
      try { wx.showTabBarRedDot({ index: CUSTOMER_TAB_INDEX }); } catch (e) { /* */ }
    } else {
      try { wx.hideTabBarRedDot({ index: CUSTOMER_TAB_INDEX }); } catch (e) { /* */ }
    }
    return summary || { unreadInquiryCount: 0, customers: [] };
  } catch (e) {
    return { unreadInquiryCount: 0, customers: [] };
  }
}

module.exports = { refreshCustomerTabBadge, CUSTOMER_TAB_INDEX };
