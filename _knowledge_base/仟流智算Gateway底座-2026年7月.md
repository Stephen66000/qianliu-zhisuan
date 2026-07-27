# 仟流智算 Gateway 底座调研｜2026 年 7 月

- 收集时间：2026-07-26（Asia/Shanghai）
- 信息来源：工作区本地源码、许可证、Git 元数据与隔离测试结果

## 结论

一期采用仟流独立 Node.js／TypeScript Gateway；TokenHub／Sub2API 只提供测试场景和设计约束，不直接复用源码。

## 关键证据

- 仟流薄 Gateway：18／18 测试通过；100 并发候选请求 100 成功、100 唯一结算。
- TokenHub：Commit `1f4e7fe2bf25084f1a525e3ba2392be1e6bc49d2`，Apache-2.0；流式提交边界、取消、Affinity 过期、资源恢复窄测试通过。
- Sub2API：本地快照 tree digest `626d7c0df33f78dfad1aa45df092372d6b8ebda5e3a1fc4f8581e500e5464ee0`，LGPL-3.0-or-later；count_tokens、Session 隔离、WebSocket 缓存、stream guard 窄测试通过；因缺 `.git`，Commit 不可证明。

## 来源

- `V3/PoC/POC-03-计量闭环-Evidence.md`
- `V3/PoC/POC-04-Gateway基线对照-Evidence.md`
- `V3/ADR-GATEWAY-BASELINE.md`
- `V3/第三方源码来源与许可证清单-v0.3.md`
