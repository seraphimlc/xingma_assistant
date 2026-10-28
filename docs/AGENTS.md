# AGENTS — 给模型的最短读序

改星马档口（仓库 `xingma_assistant`，服务器目录常仍叫 `wool-stall-miniapp`）代码前按此顺序，**勿编造未实现 API**。

## 读序

1. **[INDEX.md](./INDEX.md)** — 产品一句话、目录、怎么跑、概念、速查表  
1b. **[HANDOFF.md](./HANDOFF.md)** — 交接：部署机、审计/batch/OCR、性能、缺口  
2. **[PRD.md](./PRD.md)** — 需求与验收  
3. **[TECH.md](./TECH.md)** — 表、API、时序、环境变量名、部署只动 `wool-api`  
4. **再改代码** — 用 INDEX 速查表打开对应目录；对照 `backend/src/**/*.controller.ts` 与小程序 `pages/`  

## 硬约束

- 密钥只出现在服务器 `.env` / `backend/.secrets/` / 租户表；文档与小程序禁止写 Secret/Key 值  
- 生产域名 `https://xingma.visitworld.me`，AppID `wx394d23ea099d8a01`  
- 客户无登录 UI；分享落地静默鉴权；员工邀请走 `invite/accept`，勿与客户分享混淆  
- LKB 视频 / 外部穿搭返回的 http(s) 结果：**直接播放入库，默认不转存自有 OSS**  
- 部署/重启：**只动 pm2 进程 `wool-api`**  
- 新能力合入后：同步更新 PRD + TECH + INDEX 速查  

## 历史稿

`技术方案.md` / `部署.md` / `发品与迁移.md` / `生图模板设计.md` / `身份绑定.md` 可作补充；冲突时以 **PRD + TECH + 当前代码** 为准。
