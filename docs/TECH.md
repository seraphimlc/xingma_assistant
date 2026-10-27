# 星马档口助手 — 技术说明（TECH）

> 与当前仓库实现对齐。密钥**只写变量名，不写值**。下列接口与表均为已落地。

## 1. 架构

```
微信小程序 (AppID wx394d23ea099d8a01)
  ├─ 管理端：商品 / 客户 / 任务 / 发品 / 宣传 / 设置
  └─ 客户：share/landing 静默鉴权 → product/view（客户专用；非 product/detail）
           │ HTTPS + JWT + X-Wx-Appid
           ▼
NestJS API (:3000，生产 Nginx → https://xingma.visitworld.me/api/*)
  ├─ login/auth/wechat/tenants/invites
  ├─ products + publish + product-access
  ├─ promo（图/视频、LKB、外部穿搭、promo_sets）
  ├─ jobs（scheduler + handlers：promo_image/promo_video/…）
  ├─ media + OssClient（播放直链；external-play 应急保留未默认启用）
  ├─ vision（封面/发品识图）
  └─ customers / levels / shares / inquiries
           │
     ┌─────┼──────┐
     ▼     ▼      ▼
  MySQL  本地storage  阿里云 OSS（OSS_PROVIDER=aliyun）
  (jobs/  (OCR/开发)   前缀 OSS_PREFIX + tenants/...
   业务表)
```

技术栈：原生微信小程序 + **NestJS** + **MySQL** + **OSS** + **jobs** 表调度（Redis 配置预留，会话/限流暂未强依赖）。

`DB_ENABLED=false` 时部分模块走内存 Repository（开发）；生产必须 `true` + 迁移。

---

## 2. 数据表（migrations）

按序执行 `001`…`017`：

| 文件 | 内容 |
|------|------|
| `001_init_skeleton.sql` | tenants, tenant_members, customer_levels/profiles, product_levels, products, product_skus, rules, share_events, inquiries, media_assets, follow_ups, view_events… |
| `002_product_material_tags.sql` | 材质/标签相关补丁 |
| `003_seed_default_tenant.sql` | 租户 `tenant_dev_001` ↔ AppID；默认客户/商品等级 |
| `004_jobs.sql` | `jobs` / `job_events` |
| `005_allow_customer_download.sql` | `products.allow_customer_download` |
| `006_promo_sets.sql` | `promo_sets`；`media_assets.promo_set_id` |
| `007_tenant_contact_qr.sql` | `tenants.contact_qr_url` |
| `008_product_groups.sql` | `product_groups`；`products.group_id`；种子本季/过季 |
| `009_member_invites.sql` | `member_invites`（邀请码/角色/次数/过期/小程序码 key） |
| `010_share_limit_slots.sql` | `share_events.slot_limit` + `share_event_bindings`（限制分享前 N 位） |
| `011_tenant_allow_customer_download.sql` | `tenants.allow_customer_download` |
| `012_inquiry_contact.sql` | 询价 phone / contact_name / remark |
| `013_inquiry_staff_read.sql` | staff_read_at / handled_note |
| `014_audit_logs_and_soft_delete.sql` | audit_logs + 软删 |
| `015_media_asset_meta.sql` | media_assets.meta、products.ref_analysis |
| `016_member_invite_source.sql` | tenant_members.invite_id / invite_code |
| `017_inquiry_handler.sql` | 询价处理人 assignee_openid / assignee_name |

### 关键字段速记

**products**：`style_no`（租户内唯一）、`cover_media_ids`（JSON 图序）、`share_policy`、`allow_customer_download`、`price_display`、`status`（`on_sale|off_sale|draft`）、`level_id`、`group_id`

**jobs**：`type`（`publish_product|promo_image|promo_video|cover_reselect|media_analyze|…`）、`status`、`progress` JSON、`payload`/`result`、`attempts`/`max_attempts`、`next_run_at`

**promo_sets**：`template_id`、`params`（含 kind=image|video、generateAudio、beats/bgmId）、`caption`、`job_id`、`status`、`images` JSON（可含 objectKey 或 externalUrl/url 直链）

**media_assets**：`object_key`、`provider`、`product_id`、`promo_set_id`

**share_events**：分享策略、`slot_limit`、`bound_customer_id`（首位兼容）；**share_event_bindings**：限制分享名额占用

实体代码：`backend/src/common/entities/`。

---

## 3. 主要 API（前缀 `/api`）

鉴权：除 health 等外，管理接口 `Authorization: Bearer` + 角色守卫；客户接口经分享上下文。

### 认证 / 租户

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | code → JWT；开发 `DEV_FAKE_LOGIN` + `dev_*` code |
| GET/PATCH | `/auth/me` | 当前昵称头像；客户/员工回写 |
| GET | `/tenants/resolve` | AppID → 租户 |
| GET | `/tenants/current` | 当前租户（含 contactQrUrl） |
| PATCH | `/tenants/current/contact-qr` | 设置联系二维码 URL |
| GET | `/health` | 健康检查（`app.controller`：`/api/health`） |

### 员工邀请 invites

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/invites` | **业主**创建邀请 `{ role: owner|staff, maxUses?, expiresInDays? }` → code + wxacodeUrl |
| GET | `/invites` | **业主**邀请列表 |
| GET | `/invites/members` | 业主/员工：当前成员 |
| POST | `/invites/accept` | 已登录用户用 `{ code }` 绑定成员 |
| POST | `/invites/:id/revoke` | **业主**撤销 |
| POST | `/auth/login` | 可带 `inviteCode`：登录同时接受邀请并签发成员 JWT |

小程序：`pages/invite/accept/accept`（wxacode `page`，scene=`c=CODE`）；设置页「员工邀请」替换原占位。客户仍走商品分享，不扫此码。

### 商品

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/products` | 列表（`groupId` 过滤）/ 创建（默认进最新组） |
| GET | `/products/:id/views` | 访问日志 |
| GET/PATCH/DELETE | `/products/:id` | 详情 / 更新（含 coverMediaIds、groupId、allowCustomerDownload） |
| GET/POST | `/product-groups` | 分组列表 / 新建（sortOrder=max+10，可多组） |
| PATCH | `/product-groups/:id` | 改名（可选改 code） |
| PATCH | `/product-groups/:id/latest` | 设为最新组（本季） |
| DELETE | `/product-groups/:id` | 软删（空组、非唯一活跃组；删本季则自动提升另一组） |
| POST | `/product-groups/move-product` | 商品调组 |
| POST | `/products/parse-note` | 大文本解析 |
| POST | `/products/batch-status` | 批量上下架 |
| POST | `/products/:id/copy` | 复制为新款 |
| POST/DELETE | `/products/:id/images`… | 加图 / 删图 |
| POST | `/products/:id/cover-media/append` | 追加 mediaIds 到 coverMediaIds 末尾（生图/视频成片；去重） |
| POST/PATCH/DELETE | `/products/:id/skus`… | SKU |

### 发品 publish

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/products/publish/async` | **主路径**：multipart `files` → 草稿 + 入队，返回 jobId+productId |
| POST | `/products/publish/:batchId/enqueue` | 已有 batch 入队 |
| POST | `/products/publish/upload` | 仅攒图（兼容） |
| POST | `/products/publish/:batchId/analyze` | 分析角色/SKU/吊牌建议 |
| POST | `/products/publish/confirm` | 人工确认建品（旧路径） |

### 宣传 promo

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/promo/templates` `/promo/models` `/promo/presets` | 模板与预设 |
| POST | `/products/:id/promo/start` | 开始向导数据 |
| GET/PUT | `/products/:id/promo/feature` | 特征草案 |
| POST | `/products/:id/promo/generate` | 创建 promo_set + job |
| GET | `/products/:id/promo/sets` `/sets/:setId` | 列表 / 详情 |
| DELETE | `/products/:id/promo/sets/:setId` | 删组 |
| POST | `…/sets/:setId/regenerate` | 整组重生成 |
| POST | `…/sets/:setId/images/:index/regenerate` | 单张重生成 |
| GET | `/products/:id/promo/jobs`… | 兼容旧 job 查询 |
| POST | `…/promo/jobs/:jobId/save` | 选图保存进商品（兼容） |

### 任务 jobs

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/jobs` | 创建（内部/扩展） |
| GET | `/jobs` | 列表（筛选 type/status） |
| GET | `/jobs/meta/handlers` | 已注册 handler |
| GET | `/jobs/:id` `/jobs/:id/events` | 详情 / 事件 |
| POST | `/jobs/:id/retry` `/cancel` | 重试 / 取消 |
| POST | `/jobs/reclaim-orphans` | 业主：回收孤儿/陈旧 running → 重排队 |

### 其他

| 前缀 | 说明 |
|------|------|
| `/shares` | POST 创建；GET `:shareId/open` 首访绑定 |
| `/customers` | 列表/等级/跟进/例外规则 |
| `/levels/customer|product` | 等级 CRUD |
| `/inquiries` | 询价；`POST :id/claim` / `POST :id/handled`；`unread-summary` / `mark-read` |
| `/media/upload-credential` `/media/sign` | 上传凭证与签名 |

---

## 4. 核心流程时序

### 4.1 选图异步发品

```
员工                小程序                 API                    jobs/vision/OSS
 |-- 选图累加 ------>|                      |                         |
 |-- 提交 ---------->|-- POST publish/async -->| 落盘(+OSS) media_assets |
 |                   |                      |-- 建 draft product       |
 |                   |                      |-- enqueue publish_product|
 |                   |<-- jobId,productId --|                         |
 |                   |-- 跳转编辑页 ------->|                         |
 |                   |                      |     scheduler claim ---->|
 |                   |                      |<---- 识图/选封面/补全 ---|
 |                   |                      |     patch product        |
 |-- 任务中心查看 -->|-- GET /jobs -------->|                         |
```

batch：内存 Map，TTL≈2h；主路径可不停留在确认页。

### 4.2 宣传素材组（图 + 视频）

```
详情「宣传素材」→ promo-gallery →「新建」→ promo 向导
  图：POST …/promo/generate → promo_sets + jobs(promo_image)
      → IMAGE_GEN 和/或 OUTFIT Agent → images/caption
  视频：视频模板 → video-script（可编 beats）→ generate(mediaKind=video)
      → promo_sets(kind=video) + jobs(promo_video)
      → LKB rsync + poll → SUCCEEDED 直链入库（不转存自有 OSS）
      → 播放 URL 为上游/自有桶绝对直链（xy-tradex；不转存副本）
  → 轮询；regenerate；caption；存相册
```

- 生视频 **`generateAudio=true` 恒开**（`bgmId=none` 仅留痕）。
- 风格参考模板 `style_ref`：见 [PROMO_REF_IMAGE_DESIGN.md](./PROMO_REF_IMAGE_DESIGN.md)、[生图模板设计.md](./生图模板设计.md)。
- 外部穿搭直链：见 [PROMO_EXTERNAL_OUTFIT.md](./PROMO_EXTERNAL_OUTFIT.md)。

### 4.3 限制分享 / 公开分享

- **限制分享**（API `sharePolicy=designated_only`，文案「限制分享」）：创建时**不**从客户列表/微信挑选；链接发出后，**前 N 位**成功打开的客户（openid→customer）占用名额，写入 `share_event_bindings`；名额满后他人 403。N 默认取环境变量 `SHARE_LIMIT_SLOTS`（默认 5），创建时可传 `slotLimit`。
- **公开分享**（`open`）：不限人数、不占名额。
- 客户路径：landing 静默 login → `GET /shares/:id/open` → ensureProfile +（限制则 claim 名额）→ **`pages/product/view`**（客户专用详情）。访客自动成为客户档案。员工预览自己的分享卡片也进 view，不进管理 detail。

```
员工 POST /shares { designated_only|open, slotLimit? } → shareId
客户打开 landing?shareId= → 静默 login → GET /shares/:id/open → redirect product/view
```

### 4.5 员工/业主邀请

```
设置→生成邀请 → member_invites + wxacode(scene=c=CODE)
扫码/转发 → app 捕获 code → invite/accept（或首页跳转）
  → login{inviteCode} → tenant_members → 工作台
```

设置页「邀请记录」：**单行 nowrap**；码 + 中文状态/已用；右侧「邀请」「撤销」紧挨（小 gap）。勿与客户商品分享混淆。

### 4.4 封面选择（禁下图）

`cover-select`：排除 size_chart / lab_report / hangtag / coupon / 纯文字等；展示桶：主图 → 细节 → 场景 → 文档类沉底。可走 VISION_* 多模态；失败有启发式兜底。

---

## 5. 环境变量（只列名）

来源：`backend/.env.example`（生产放服务器 `.env`，**不入仓**）。

| 分组 | 变量名 |
|------|--------|
| 服务 | `PORT` `NODE_ENV` `APP_BASE_URL` |
| 微信 | `WECHAT_APP_ID` `WECHAT_APP_SECRET` `DEV_FAKE_LOGIN` |
| MySQL | `DB_ENABLED` `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` |
| Redis（预留） | `REDIS_HOST` `REDIS_PORT` `REDIS_PASSWORD` |
| JWT | `JWT_SECRET` `JWT_EXPIRES_IN` |
| OSS | `OSS_PROVIDER` `OSS_REGION` `OSS_ENDPOINT` `OSS_BUCKET` `OSS_PREFIX` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET`；签名过期 `OSS_SIGNED_URL_EXPIRES`（默认 3600，兼容 `OSS_SIGNED_TTL`）；对象 ACL `OSS_OBJECT_ACL=public-read`（当前）；`OSS_PUBLIC_READ=1` 返回永久公网 URL；可选 `MEDIA_PUBLIC_BASE` `MEDIA_SERVE_LOCAL`；兼容别名 `ALIYUN_*` |
| 生图 | `IMAGE_GEN_BASE_URL` `IMAGE_GEN_API_KEY` `IMAGE_GEN_MODEL` `IMAGE_GEN_REF_MODE` `IMAGE_GEN_CONCURRENCY` `IMAGE_GEN_TIMEOUT_MS` |
| 视觉 | `VISION_BASE_URL` `VISION_API_KEY` `VISION_MODEL` `VISION_TIMEOUT_MS` `VISION_MAX_CANDIDATES` `VISION_OCR_CONCURRENCY` `ENABLE_MAC_VISION_OCR` |
| 宣传视频 | `VIDEO_ENGINE=lkb|xytoken`；LKB：`VIDEO_LKB_AGENT_BASE_URL` `VIDEO_LKB_AGENT_KEY`/`KEY_FILE`/`LKB_AGENT_CALL_KEY` `VIDEO_LKB_AGENT_TENANT_ID` `VIDEO_LKB_AGENT_CODE`；xytoken 兜底：`VIDEO_GEN_*`（默认复用 VISION） |
| 任务 | `JOB_SCHEDULER` `JOB_CONCURRENCY` `JOB_POLL_MS` `JOB_AUTO_RETRY` `JOB_STALE_MS`（默认 2700000=45min） `DEFAULT_PRODUCT_LEVEL_ID` |

生产检查：`DEV_FAKE_LOGIN=false`；`WECHAT_APP_SECRET` 或 `tenants.wx_app_secret` 已配置；`JWT_SECRET` 非默认串。

---

## 6. 小程序要点

| 项 | 位置 / 值 |
|----|-----------|
| baseUrl / appId | `miniprogram/app.js` → 生产 `https://xingma.visitworld.me` / `wx394d23ea099d8a01` |
| Tab | 商品 / 客户 / 任务 / 设置 |
| 请求封装 | `utils/request.js`（带 token、`X-Wx-Appid`、静默 login） |
| 存相册 | `utils/saveAlbum.js` |
| SKU UI | `components/sku-list` |

合法域名（mp 后台）：
- request = `xingma.visitworld.me`
- uploadFile / **downloadFile** 均需：`xy-tradex.oss-cn-shenzhen.aliyuncs.com`（自有 OSS + LKB 成片同桶直链）
- 可选保留 `xingma.visitworld.me`（本站下载 / 应急 `/api/media/external-play`）。默认播放已改回直链，不再改写为 external-play。
- `<image>` 展示网络图一般不要求 downloadFile；`<video src>` / `wx.downloadFile` 查 downloadFile 列表。

### OSS 读链接（当前：公开读）

- 当前生产：`OSS_PUBLIC_READ=1` + `OSS_OBJECT_ACL=public-read`。`OssClient.publicUrl` 返回 `https://{bucket}.{endpoint}/{OSS_PREFIX}/{objectKey}`（**无** `Signature` 查询参数）。
- 请在阿里云控制台确认 Bucket（及历史对象）为 **公共读 / public-read**；仅改 `.env` 不会自动改桶 ACL。
- 新上传（服务端 put / PostObject）带 `x-oss-object-acl: public-read`。
- 若改回私有桶：设 `OSS_PUBLIC_READ=0`、`OSS_OBJECT_ACL=private`，读链接恢复短时签名 GET（`OSS_SIGNED_URL_EXPIRES`，默认 1h）。
- `MEDIA_SERVE_LOCAL=1` 时可强制回退同域 `/media/`（微信未配 OSS 域名时）。

### 外部结果直链（不转存 OSS）

| 场景 | 行为 |
|------|------|
| LKB 视频 SUCCEEDED | 持久化上游 videoUrl → images[].url/externalUrl；media `provider=external`；不 put 自有 OSS |
| 外部穿搭出图 | http(s) 直链入库；非 URL 才回退下载+OSS |
| 播视频 | `itemPlayUrl` 原样返回 http(s) 直链（`https://xy-tradex.oss-cn-shenzhen.aliyuncs.com/...`）；**不**改写为 external-play |

应急：`media.service`（`buildExternalPlayUrl` / `verifyExternalPlayToken` / `isAlreadyPlayableHost`）+ `media-external-play.controller.ts` 仍保留，默认未接入 itemPlayUrl。

---

## 6.1 IMAGE_GEN 提示词与参数留痕

- **不需新表**：`job_events.data`（JSON，追加）+ `promo_sets.images[]`（JSON）即可。
- 每次 IMAGE_GEN：写 `job_events` 事件 `image_gen`（`prompt`/`promptEn` 英文最终、`promptZh` 中文原话、`model`、`size`、`setId`、`index`、`refObjectKeys`、`via`、成败/耗时、`garmentPrep`）。
- `promo_sets.images[i].prompt/promptZh/promptEn/model/size` = 该槽**最近一次**中英提示词与参数；`genCalls[]` **追加**历次调用（重生不丢历史，每槽最多 30 条）。
- `promo_sets.params.imageGenModel` = 上游模型名；`garmentCategory` 当前固定 `knitwear`（羊毛衫）；进度仍走 `jobs.progress`。

## 6.2 羊毛衫生图标准流程（按品类，勿糊通用）

代码：`backend/src/promo/garment-ref-prepare.ts`（`prepareRefsForCategory('knitwear')`）。

1. **识图分类**：对全部商品参考图标 `hang`（挂拍/平铺）/ `detail`（领口袖口织纹）/ `unusable`（非针织成衣、尺码表、吊牌、杂乱一堆等）。原图保留，不静默丢弃；不可用记原因。
2. **细节不足 → 宫格**：无足够领/袖/织纹细节时，对挂拍切 6（2×3）或 9（3×3）宫格，宫格细胞作补充细节参考（挂拍原图仍送模）。
3. **角色写入 prompt**：`REFERENCE IMAGE ROLES` 标明每张参考图职责；另附 `GARMENT HARD CONSTRAINTS` 英文硬约束。
4. **中英留痕**：`promptZh` = 用户中文原话 + 读衣中文；`prompt`/`promptEn` = 送 IMAGE_GEN 的英文最终稿。
5. **拒生**：非羊毛衫/针织成衣，或读不出完整单件 → 任务失败并返回中文原因（事件 `garment_prep` / job error）。

扩展：鞋子/裤子/衬衣在 `CATEGORY_PREPARE_REGISTRY` 另立专用流程后再注册；未注册品类直接拒生，禁止复用羊毛衫逻辑充数。

## 6.3 外部穿搭 Agent 与同图对比

详见 [PROMO_EXTERNAL_OUTFIT.md](./PROMO_EXTERNAL_OUTFIT.md)。

- 客户端：`external-outfit.client.ts`；`POST {OUTFIT_AGENT_BASE_URL}/api/invocations/sync`，`Authorization: Bearer`，`agentCode=ai-adaptive-outfit-workflow`。
- 参数：`garmentImages` 1～9、可选 `modelImageUrl` / `instruction`。Token：`OUTFIT_AGENT_API_KEY` 或 `OUTFIT_AGENT_API_KEY_FILE`（本机 `.secrets/`，不入仓）。
- `OUTFIT_ENGINE=self|external|both`：`both` 时同参考图双跑，结果写入 `promo_sets.images[i].compare`（self 主图 + external.imageUrls）。
- 事件：`external_outfit`（job_events）。

环境变量：`OUTFIT_AGENT_ENABLED` `OUTFIT_AGENT_BASE_URL` `OUTFIT_AGENT_API_KEY` `OUTFIT_AGENT_API_KEY_FILE` `OUTFIT_AGENT_CODE` `OUTFIT_AGENT_TIMEOUT_MS` `OUTFIT_ENGINE`。

### 6.4 商品图异步分析落库（生图复用）

- Job：`media_analyze`（payload 可选 `productId` / `styleNo` / `force`；缺省扫租户全部商品）。
- 落库：`media_assets.meta`（kind/roleZh/roleEn/sortHint/via/analyzedAt）；`products.ref_analysis`（整款读衣摘要 + assets[]）；并按 sortHint 重排 `cover_media_ids`。
- 生图：`prepareRefsForCategory` 在参考图均有落库 kind 时 `reuseCached`，跳过重复识图分类，硬约束取 `ref_analysis`。
- 迁移：`015_media_asset_meta.sql`。



### 业主 task vs 框架 job（2026-10-24）

- **task（业主）**：一次生图/生视频/发品动作；生图·视频对应一个 `promo_sets`（槽位在创建时固定，重生只换槽内图）。
- **job（框架）**：调度执行单元（整组生成、单槽重生、发品等）；`/api/jobs` 仍供调试；任务中心 / 本商品任务默认按 set 呈现，成功素材只在「宣传素材」。

## 7. 部署注意（只动 wool-api）

服务器目录：`/srv/wool-stall-miniapp`。同机可能跑**多个** pm2 应用。

**规则**：更新本项目后端时：

1. 同步/拉取 `backend` 代码与依赖  
2. `npm ci && npm run build`（在 backend 目录）  
3. **仅** `pm2 restart wool-api`（或等价只重启该 name）  
4. **不要** `pm2 restart all`，不要动其他项目进程与 Nginx 无关 server  

文档可单独同步到 `/srv/wool-stall-miniapp/docs/`，**无需**重启进程。

迁移：新 SQL 在维护窗口执行；`synchronize=false`，以 `migrations/*.sql` 为准。

更完整的 Nginx/证书清单见历史稿 `部署.md`。

---

## 8. 已落地补充 & 仍可迭代

### 8.1 客户资料 / 订阅 / 业主二维码

均已落地（软完善资料、订阅可配、设置页联系二维码）。拒绝授权不阻断看货。

### 8.2 宣传视频（LKB）— 已落地

见 §4.2：rsync+poll、`generateAudio=true`、直链不转存 OSS、上游/自有桶直链播放（xy-tradex）。模板含 product_showcase / street_walk / multi_color_outfit / cafe_lifestyle / detail_macro。密钥 `VIDEO_LKB_*` / `.secrets/lkb-video-agent.key`。兜底 `VIDEO_ENGINE=xytoken`。

### 8.3 仍可迭代

配乐按曲目选择（今日仅布尔出音 + bgmId 留痕）；外部穿搭并排预览增强；多镜拼接长视频。

---

## 9. 相关代码索引

| 主题 | 路径 |
|------|------|
| 发品 | `src/products/publish/` `jobs/handlers/publish-product.handler.ts` |
| 封面 | `src/vision/cover-select.ts` |
| 宣传 | `src/promo/` `jobs/handlers/promo-image.handler.ts` |
| 任务标题 | `src/jobs/job-display-title.ts` |
| OSS | `src/media/oss.client.ts` |
| 访问控制 | `src/products/product-access.service.ts` |
| 邀请 | `src/invites/` `pages/invite/accept` `pages/settings`（邀请记录单行 UI） |
| 询价处理 | `src/inquiries/` `pages/inquiry/` `pages/customer/` |
| 客户目录 | `pages/product/catalog/` `pages/product/view/` |
| 外部视频中转（应急） | `src/media/media-external-play.controller.ts` `media.service.ts`（默认播放直链） |
| LKB 视频 | `src/promo/lkb-video.client.ts` |



### 任务孤儿回收（running 卡死）

单进程 worker：调度器只 claim `queued`；进程死亡后 `running` 会永久卡住。

- **启动**：`JobSchedulerService.onModuleInit` 调用 `JobsService.reclaimOrphanedRunning({ onlyStale: false })`，把**全部** `running` 改回 `queued`（清 `lockedBy`，进度消息「进程中断，已重新排队继续」；`attempts` 减 1 抵消 claim，不轻易烧尽 `maxAttempts`）。
- **运行中**：约每 20 tick / 60s 对 `updated_at` 早于 `JOB_STALE_MS`（默认 45 分钟）的 `running` 同样重排队。活任务靠 `updateProgress`→`save` 刷新 `updated_at`。
- **不**因孤儿/陈旧标记 `failed`；仅 handler 抛错且 attempts 用尽、或用户取消才结束。
- `promo_image`：关联 `promo_sets` 若误为 `failed`，重排队时改回 `generating`；本来就是 `generating` 则保持。
- 手动：`POST /api/jobs/reclaim-orphans`（owner）。

## 附录：宣传多色与去重

- `buildJobDisplayTitle`：`templateId=multi_color` → `多色展示 · 款号… · N色`，不用「场景里的模特」。
- 多色展示：N 色 → N 张上身图（同模特/姿态/场景，每张只喂该色参考）；非拼贴。
- `promo.generate`：同商品+模板已有 generating/queued 任务则**复用**，不双开。
- `listJobs`：进行中框架 job 与挂 `_frameworkJobId` 的 legacy `pj_*` 去重，只留一条。
- 任务列表 / `listSets`：进行中同 setId 或同模板只展示一条；隐藏空壳 generating 幽灵组。

## 附录：媒体中转上传

- `POST /api/media/upload` multipart `file`（员工）：落盘 `storage/tenants/...` + OSS `putObjectSafe`，返回 `{ url, objectKey }`。
