# 交接说明（HANDOFF）— 给接手同事

> 更新于 2026-10-28。密钥**只写变量名**，不写值。冲突时以 **代码 + PRD + TECH** 为准。

## 1. 仓库与环境

| 项 | 值 |
|----|----|
| GitHub | `seraphimlc/xingma_assistant`（fork 推送常用 `Cookieboty/xingma_assistant` → PR 合 main） |
| 本机路径 | `~/Documents/gitproject/xingma_assistant`（微信开发者工具直接打开 `miniprogram/`） |
| 生产域名 | `https://xingma.visitworld.me` · AppID `wx394d23ea099d8a01` |
| 服务器 | 与巡店旧机同机：`store-old` / `8.216.43.224`；代码目录 **`/srv/wool-stall-miniapp`** |
| 进程 | pm2 **`wool-api`**（同机还有 gongjian / sinan / 旅游 / 知行学堂等，**禁止** `pm2 restart all`） |
| 健康检查 | `GET /api/health` |

### 部署（只动 wool-api）

生产目录**无 git**（历史用 rsync）。本机改完合入 `main` 后：

```bash
# 本机（仓库根）
SHA=$(git rev-parse --short HEAD)
rsync -az --delete ./backend/src/ store-old:/srv/wool-stall-miniapp/backend/src/
rsync -az ./backend/migrations/ store-old:/srv/wool-stall-miniapp/backend/migrations/
rsync -az --delete ./docs/ store-old:/srv/wool-stall-miniapp/docs/
# 服务器
ssh store-old
cd /srv/wool-stall-miniapp/backend
# 新迁移：mysql … < migrations/0xx_*.sql（Duplicate key name 可忽略）
npm run build          # 一般不必 npm ci，除非 package-lock 变了
pm2 restart wool-api   # 禁止 pm2 restart all
curl -s https://xingma.visitworld.me/api/health
```

备份习惯：部署前把 `backend/src`（及需要时的 migrations/docs）拷到 `.deploy-bak/YYYYMMDD_HHMMSS_<sha>/`。

`.env` / `backend/.secrets/` / `storage/` **保留在服务器**，rsync 不要覆盖。

## 2. 文档入口

1. [INDEX.md](./INDEX.md) — 目录、概念、速查  
2. [PRD.md](./PRD.md) — 需求验收  
3. [TECH.md](./TECH.md) — 表 / API / 时序 / 环境变量  
4. [AGENTS.md](./AGENTS.md) — 给模型的最短读序  
5. [部署.md](./部署.md) — Nginx / 证书 / 清单  

## 3. 近期能力（接手必知）

### 3.1 审计日志 `audit_logs`

- 迁移：`014_audit_logs_and_soft_delete.sql`、`018_audit_actor_nickname.sql`
- 代码：`backend/src/common/audit.service.ts` + 各 service `audit.enqueue(...)`
- 字段：actor（member/openid/role/**nickname 快照**）+ target + action + `detail_json`
- 系统/任务写操作用 `actor_role=system|job`，**不伪造真人**
- **无分析 UI**；查库即可。示例：
  ```sql
  SELECT created_at, actor_role, actor_nickname, action, target_type, target_id
  FROM audit_logs WHERE tenant_id='tenant_dev_001' ORDER BY id DESC LIMIT 50;
  ```

### 3.2 发品 batch 磁盘持久化

- 代码：`backend/src/products/publish/publish-batch.store.ts`
- 路径：`backend/storage/tenants/{tenantId}/uploads/{batchId}/_batch.json`
- TTL ≈ 2h；内存 L1 + 磁盘，**pm2 restart 后仍可取**
- 选磁盘而非 Redis：生产曾配 `REDIS_*` 但 redis-server 未装

### 3.3 吊牌 OCR / tesseract

- 代码：`backend/src/products/publish/publish-analyze.ts`
- 路径：多模态 →（可选 Mac Vision）→ **tesseract**（`chi_sim+eng`）
- 生产需：`tesseract-ocr` + `tesseract-ocr-chi-sim`（或 `TESSERACT_PATH`）
- 失败：**不**编造 styleNo、**不**建假品；备注写进 ocrNote

### 3.4 列表性能（2026-10-28）

- 商品列表：SKU **批量** `listSkusByProductIds`（消灭 N 次 `listSkus`）；封面 URL 已 batch；列表响应**省略完整 skus**（保留 `priceText` / `colorCount`）
- 商品分页：`getManyAndCount` 一次完成
- 任务列表孤儿失败组：关联 job **批量** `In(...)` 查询
- 索引迁移：`019_list_perf_indexes.sql`（products / product_skus / promo_sets / inquiries）

## 4. 已知缺口 / 风险（残余）

| 项 | 说明 |
|----|------|
| Redis | 配置预留；生产未强依赖；发品 batch 已改磁盘 |
| 客户目录 listForCustomer | 仍按页拉全量再 ACL 过滤；商品很多时应用 DB 侧策略预筛 |
| 任务 list | 多取再去重/截断，`total`≈当前页长度，非全库 count |
| 宣传视频配乐 | 仅布尔出音 + bgmId 留痕，无曲目选择 UI |
| 外部穿搭并排预览 | 基础已落地，UI 可再增强 |
| 多镜长视频 | 未做 |
| 审计 | 仅 append-only；无后台报表 |
| 小程序包体 | 未做分包优化；打开慢优先查 API（已处理一批 N+1） |
| Git 权限 | 直推 `seraphimlc` main 可能受限；走 Cookieboty fork PR |

## 5. 常用路径

| 功能 | 路径 |
|------|------|
| 商品列表 API | `products.service.ts` `listForStaff` / repositories |
| 任务中心 | `jobs/jobs.service.ts`；`pages/jobs/` |
| 发品 | `products/publish/`；`jobs/handlers/publish-product.handler.ts` |
| 宣传图/视频 | `promo/`；`pages/product/promo/` |
| 客户/询价红点 | `customers/` `inquiries/`；`utils/customer-tab-badge.js` |

## 6. 不要做的事

- 提交 Secret / Key / `.env` 值  
- `pm2 restart all` 或动同机其它项目  
- 把客户分享与员工邀请流程混用  
- 默认把 LKB/外部穿搭结果转存自有 OSS（现行策略：直链播放）
