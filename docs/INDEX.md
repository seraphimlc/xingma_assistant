# 星马档口助手 — 文档索引

> 给人看也给模型看。改功能前先读本页 → [PRD](./PRD.md) → [TECH](./TECH.md)；模型最短读序见 [AGENTS](./AGENTS.md)。

## 一句话产品

多租户微信小程序：档口业主/员工管商品与客户、做宣传图/短视频素材；客户经分享卡片静默打开详情并可询价、逛公开目录。

## 关键标识

| 项 | 值 |
|----|----|
| 仓库根 | `xingma_assistant/`（历史目录名 `wool-stall-miniapp` 仍见于服务器路径） |
| 生产域名 / API | `https://xingma.visitworld.me`（路径 `/api/*`） |
| 小程序 AppID | `wx394d23ea099d8a01` |
| 默认租户 | `tenant_dev_001`（见 `backend/migrations/003_seed_default_tenant.sql`） |
| 后端进程名（生产） | `wool-api`（pm2）；**部署只重启/替换该进程，勿动同机其他服务** |
| 服务器代码目录 | `/srv/wool-stall-miniapp` |
| 小程序 baseUrl | `miniprogram/app.js` → `globalData.baseUrl` |

## 目录树（关键路径）

```
xingma_assistant/
├── docs/                      # INDEX / PRD / TECH / AGENTS + 专题/历史稿
├── backend/                   # NestJS API
│   ├── src/
│   │   ├── login/ auth/ wechat/ tenants/ invites/
│   │   ├── products/          # CRUD + product-access + publish/
│   │   ├── promo/             # 图/视频模板、生图、LKB 视频、外部穿搭、promo_sets
│   │   ├── jobs/              # 通用异步任务 + handlers/
│   │   ├── media/             # 上传、签名、OSS
│   │   ├── vision/            # 看图选封面 / 发品识图
│   │   ├── customers/ levels/ shares/ inquiries/
│   │   └── common/entities/
│   ├── migrations/            # 001…019 SQL
│   ├── storage/               # 本地媒体落盘（OCR/开发）
│   └── .env.example / .secrets/（gitignore）
└── miniprogram/
    ├── app.js / app.json      # Tab：商品 / 客户 / 任务 / 设置
    ├── utils/                 # request / saveAlbum / invite / profile / …
    ├── components/sku-list/
    └── pages/
        ├── index/             # 员工登录；邀请码跳转 accept
        ├── product/{list,detail,view,catalog,edit,publish,promo,promo-gallery}/
        ├── customer/{list,detail}/
        ├── jobs/{list,detail}/
        ├── inquiry/{list,detail}/
        ├── invite/accept/     # 员工邀请兑换
        ├── share/landing/     # 分享静默落地
        └── settings/index/    # 等级、联系二维码、员工邀请、下载开关等
```

历史中文稿（冲突以 PRD/TECH + 代码为准）：`技术方案.md`、`部署.md`、`发品与迁移.md`、`生图模板设计.md`、`身份绑定.md`。专题：`PROMO_REF_IMAGE_DESIGN.md`、`PROMO_EXTERNAL_OUTFIT.md`。

## 本地怎么跑

### 后端

```bash
cd backend
cp .env.example .env
# 本地联调建议：DEV_FAKE_LOGIN=true；可先 DB_ENABLED=false 用内存仓
npm install && npm run build && npm run start:dev
```

- 监听：`http://127.0.0.1:3000` · `GET /api/health`
- 连 MySQL：`DB_ENABLED=true` + 按序执行 `migrations/001`…`019`（见 TECH）

### 小程序

1. 微信开发者工具导入 `miniprogram/`
2. 本地临时改 `baseUrl: 'http://127.0.0.1:3000'`，勾选不校验合法域名
3. 上线前改回 `https://xingma.visitworld.me`

### 生产

- API：Nginx → Nest `:3000`；**只** `pm2 restart wool-api`
- 文档可同步到 `/srv/wool-stall-miniapp/docs/`（无需重启）

## 文档导航

| 文档 | 用途 |
|------|------|
| [INDEX.md](./INDEX.md) | 本页：入口、跑法、概念、速查 |
| [PRD.md](./PRD.md) | 产品需求与验收 |
| [TECH.md](./TECH.md) | 架构、表、API、时序、环境变量、部署 |
| [AGENTS.md](./AGENTS.md) | 给模型的最短读序与改码约束 |
| [PROMO_REF_IMAGE_DESIGN.md](./PROMO_REF_IMAGE_DESIGN.md) | 风格参考图（已实现） |
| [PROMO_EXTERNAL_OUTFIT.md](./PROMO_EXTERNAL_OUTFIT.md) | 外部穿搭 Agent + 直链不转存 OSS |
| [生图模板设计.md](./生图模板设计.md) | 宣传图模板一览 |
| [部署.md](./部署.md) | Nginx / 证书 / 迁移清单 |
| [HANDOFF.md](./HANDOFF.md) | **同事交接**：部署主机、审计/发品 batch/OCR、性能改动、已知缺口 |

## 关键概念

| 概念 | 含义 |
|------|------|
| **tenant** | 一个档口/一个小程序 AppID；业务表均带 `tenant_id`；头 `X-Wx-Appid` |
| **batch** | 发品上传批次（内存，TTL≈2h）；主路径上传后立刻建草稿并入队 |
| **job** | 通用异步任务：`publish_product` / `promo_image` / `promo_video` / `cover_reselect` / `media_analyze`…；陈旧 running 由调度器 reclaim 重排队 |
| **promo_set** | 宣传素材组：一商品多组；图或视频（`params.kind=video`）；关联 `job_id` |
| **externalUrl** | 上游（LKB 视频 / 外部穿搭）返回的可播放 http(s) 直链；入库后**优先播放**，不强制转存自有 OSS |
| **catalog** | 客户公开商品目录页；分享详情「房子/更多」进 catalog，**不**进员工 list |
| **inquiry handler** | 待沟通 → 我来沟通(`in_progress`) → 已处理(`handled`)；红点不计已处理 |
| **coverMediaIds** | 商品封面/图序 JSON；编辑页可调序 |
| **sharePolicy** | `open` 公开 / `designated_only` 限量转发前 N 位（`SHARE_LIMIT_SLOTS`） |

## 「改 XX 功能看这些文件」速查

| 要改的功能 | 优先打开 |
|------------|----------|
| 登录 / 假登录 / 首位业主 | `backend/src/login/` `wechat/` `tenants/`；`pages/index/` `utils/request.js` |
| 员工邀请 | `backend/src/invites/`；`pages/invite/accept/` `utils/invite.js`；`pages/settings/` |
| 商品列表/CRUD/分组 | `backend/src/products/`；`pages/product/list|edit/` |
| 选图异步发品 / batch | `products/publish/` `jobs/handlers/publish-product.handler.ts` `vision/`；`pages/product/publish/` |
| 客户详情 / 公开目录 | `pages/product/view/` `pages/product/catalog/`；`utils/profile.js` |
| 分享策略 | `products/product-access.service.ts` `shares/`；`pages/share/landing/` |
| 宣传图 / 外部穿搭 | `backend/src/promo/`；`pages/product/promo/`；`PROMO_*` |
| 宣传视频 / LKB | `promo/lkb-video.client.ts` `promo.service.ts`（直链入库 + 直链播放）；`promo.templates` 视频模板 |
| 任务中心 | `jobs/` `job-display-title.ts`；`pages/jobs/` |
| OSS / 媒体 / 直链 | `media/oss.client.ts` `media.service.ts`（桶 xy-tradex 深圳）；播放直链（应急 `GET /api/media/external-play`）；promo 槽位 `externalUrl`/`url` |
| 询价处理流 | `inquiries/`；`pages/inquiry/` `pages/customer/`；`utils/customer-tab-badge.js` |
| 部署 | `docs/部署.md` + TECH「部署注意」 |

## 不做（首期明确边界）

交易支付物流、读微信好友/笔记客户端、跨档口大厅、聊天直达。
