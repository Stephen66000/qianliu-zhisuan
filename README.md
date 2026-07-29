# 仟流智算项目目录

本仓库采用 pnpm Monorepo。正式程序不再额外套一层“程序”目录，工程入口保持稳定。

| 路径 | 内容 | 当前性质 |
| --- | --- | --- |
| `apps/` | Web、Control API、Gateway、Worker | 正式程序 |
| `packages/` | 领域、数据库、合同、适配器、配置、测试等共享包 | 正式程序 |
| `deploy/` | Docker Compose、Caddy、数据库初始化 | 正式部署 |
| `V3/` | 当前 PRD、TRD、计划、审核、Handoff、Evidence | 当前项目文档 |
| `原型/V3/` | v0.3 当前 V4 原型及走查资料 | 当前原型 |
| `_knowledge_base/` | 项目调研与外部事实记录 | 当前知识库 |
| `参考/` | TokenHub、Sub2API 的隔离行为对照 | 只读参考，不是产品源码 |
| `_quarantine/` | 已被替代但需要保留的历史文档和原型 | 封禁区，不参与构建 |

## 常用入口

```bash
corepack pnpm@11.11.0 install --frozen-lockfile
corepack pnpm@11.11.0 run typecheck
corepack pnpm@11.11.0 run lint
corepack pnpm@11.11.0 run test
corepack pnpm@11.11.0 run build
```

数据库迁移入口为 `corepack pnpm@11.11.0 run db:migrate`，部署说明见 `V3/Evidence/M7/`。

`node_modules/`、`dist/`、测试报告、缓存和系统文件均为可再生成内容，不属于项目源码。历史封禁内容的来源和恢复方式见 [`_quarantine/MANIFEST.md`](./_quarantine/MANIFEST.md)。
