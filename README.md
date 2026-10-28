# 星马档口助手（xingma_assistant）

每位业主一个独立微信小程序 + 统一 SaaS 多租户后端（NestJS / MySQL / OSS / jobs）。

生产：`https://xingma.visitworld.me` · AppID `wx394d23ea099d8a01` · pm2 进程名 **`wool-api`**（只重启该进程）。

## 仓库结构

```
xingma_assistant/
  docs/           # INDEX / PRD / TECH / AGENTS + 专题稿
  backend/        # NestJS API
  miniprogram/    # 原生微信小程序（开发者工具打开此目录）
  README.md
```

文档入口：[docs/INDEX.md](./docs/INDEX.md) → [PRD](./docs/PRD.md) → [TECH](./docs/TECH.md)。

## 快速启动

### 1. 后端

```bash
cd backend
cp .env.example .env   # 默认 DB_ENABLED=false，内存 Repository 可跑
npm install
npm run build
npm run start:dev
```

- 服务：`http://127.0.0.1:3000` · 健康检查 `GET /api/health`
- 本地建议 `DEV_FAKE_LOGIN=true`（不调微信；员工假登录；客户走分享静默鉴权）
- 连 MySQL：见 [backend/README.md](./backend/README.md)；生产见 [docs/部署.md](./docs/部署.md)
- 密钥（微信 / OSS / IMAGE_GEN / LKB 视频 / 外部穿搭 Agent）只放服务器 `.env` 或 `backend/.secrets/`，**不入仓**

### 2. 小程序

1. 微信开发者工具导入 `miniprogram/`
2. AppID 已是 `wx394d23ea099d8a01`
3. `app.js` → `globalData.baseUrl` 生产为 `https://xingma.visitworld.me`；本地联调可临时改 `http://127.0.0.1:3000`，并勾选「不校验合法域名」
4. 员工：首页「微信登录」→ Tab 商品 / 客户 / 任务 / 设置
5. 客户：**无登录页**；点开分享卡片 → `share/landing` 静默鉴权 → `product/view`

### 3. 分享与员工邀请

| 路径 | 说明 |
|------|------|
| 商品分享 | 员工创建限制/公开分享 → 客户落地静默进 `product/view`；限制分享前 N 位占名额（默认 `SHARE_LIMIT_SLOTS=5`） |
| 员工邀请 | 设置页生成邀请码/小程序码 → 扫码进 `invite/accept` 兑换成员；**不是**客户分享 |

### 4. 已落地能力（摘要）

- 商品/SKU CRUD、复制、批量上下架、分组、搜索（含款号）、公开/限量转发
- 选图异步发品、封面禁尺码表、宣传图多模板（含风格参考 / 外部穿搭 Agent）
- **宣传视频**：LKB `sinan-video-generator`（`rsync` + poll）；`generateAudio=true`；上游 SUCCEEDED 直链播放，**不转存自有 OSS**（穿搭图同策略）
- 任务中心（业主按 promo_set 呈现）、询价处理流（认领 / 已处理 / 红点）
- 客户公开目录 `product/catalog`（房子/「更多」进目录，不进管理端）
- 首次分享落地软提示完善资料（头像+昵称+手机，可跳过）

详见 [docs/PRD.md](./docs/PRD.md)、[docs/TECH.md](./docs/TECH.md)。

## 明确不做

交易支付物流、读微信笔记/好友客户端、跨档口大厅、IM 聊天直达。

## 交接

同事接手请先读 [docs/HANDOFF.md](./docs/HANDOFF.md)（部署主机、审计日志、发品 batch 落盘、吊牌 OCR、列表性能与已知缺口）。日常文档入口仍是 [docs/INDEX.md](./docs/INDEX.md)。

