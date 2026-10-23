# 羊毛衫档口商品与客户管理小程序

每位业主一个独立微信小程序 + 统一 SaaS 多租户后端（NestJS / MySQL / Redis）。

## 仓库结构

```
wool-stall-miniapp/
  docs/技术方案.md     # 完整技术方案
  backend/             # NestJS API
  miniprogram/         # 原生微信小程序
  README.md
```

## 快速启动

### 1. 后端

```bash
cd backend
cp .env.example .env   # 默认 DB_ENABLED=false，内存 Repository 可跑
npm install
npm run build
npm run start:dev
```

服务地址：`http://127.0.0.1:3000`  
健康检查：`GET /api/health`

本地开发建议 `.env` 设 `DEV_FAKE_LOGIN=true`（不调微信，首页仅员工假登录；客户走分享静默鉴权）。
连接 MySQL：见 [backend/README.md](./backend/README.md)；生产部署见 [docs/部署.md](./docs/部署.md)。

**客户无登录**：客户不需要登录页、也不主动点登录；点开业主分享的商品卡片后，小程序在落地页后台 `wx.login` 换 openid/JWT 并跳转详情。

## 生产配置

- 域名 / API：`https://xingma.visitworld.me`（路径 `/api/*`）
- 小程序 AppID：`wx394d23ea099d8a01`
- AppSecret：仅服务器环境变量 `WECHAT_APP_SECRET`（或 tenants 表），**不入仓库**

### 2. 小程序

1. 打开微信开发者工具，导入目录 `miniprogram/`
2. `project.config.json` 的 `appid` 已是 `wx394d23ea099d8a01`
3. `app.js` 的 `globalData.baseUrl` 默认 `https://xingma.visitworld.me`；本地联调临时改为 `http://127.0.0.1:3000`，并勾选 详情 → 本地设置 → **不校验合法域名**
4. 首页仅「微信登录（员工身份）」；客户路径无登录按钮。开发态员工假登录需 `DEV_FAKE_LOGIN=true`

### 3. 分享绑定演示路径（客户无感）

1. 以员工登录 → 打开商品详情 → 「限制分享」得到 `shareId`
2. 客户打开 `pages/share/landing/landing?shareId=xxx`（或模拟另一客户会话）→ 后台静默鉴权 → 立刻进商品详情
3. 限制分享：前 N 位客户打开自动建档并占名额；名额满后拒绝。公开分享不限
4. 无分享参数直接进首页时，提示「请通过分享卡片打开」，不逼登录

### 4. 本轮已落地能力（摘要）

- 商品/SKU 完整 CRUD、复制、批量上下架、搜索与过滤
- 客户等级 / 商品等级配置 CRUD
- 客户档案：改等级、批量改等级、跟进、例外规则
- Repository 层：内存 + TypeORM（`DB_ENABLED` 切换）
- 小程序：商品编辑/列表、设置等级、客户列表/详情对接 API

详见 [docs/技术方案.md](./docs/技术方案.md) §5 API 列表。

## 首期范围

已做：员工登录 + 客户分享静默鉴权、商品鉴权与 CRUD、限制分享名额占用 / 公开分享、询价、媒体签名占位、等级配置、实体与 DDL。  
不做：交易支付物流、读微信笔记/好友、跨档口大厅、聊天直达。
