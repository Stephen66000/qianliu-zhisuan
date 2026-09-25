# 提交号映射（rebase 后）— 2026-09-22

> 原因：F-P1-7 处置执行 rebase（基线 `ca533e3d` → `5160002`），本候选 18 个提交全部重写。
> 旧提交号在新历史中不再可达（仍可由回退分支与 reflog 找回），此前 I1 报告、
> WP01～WP08 GO/NO-GO 报告、指纹清单中引用的短 SHA 需按本表换算，避免审计链断裂。

| 旧短 SHA | 新短 SHA | 提交摘要 |
|---|---|---|
| `10059ee` | `8a977aa` | chore(openspec): import provider-finance-initialization |
| `45c54de` | `2953fa5` | feat(finance): WP01 资金账本初始化合同、候选/幂等、静默租约与资源资金状态 |
| `aaacbab` | `d7505bc` | fix(finance): WP01 复核收口——日常表单证据必填、日期夹具与迁移断言 |
| `6b019e9` | `1e44f77` | feat(finance): WP02 只读候选投影、完整事实水位与切换时点至候选水位守恒 |
| `5c71b78` | `740c2cf` | feat(finance): WP03 企业级原子激活、四字段修复原语与幂等终态 |
| `8d568b3` | `25ec8d8` | fix(finance): WP03 复核收口——排空门禁豁免候选已冻结的固定修复行 |
| `a11af6e` | `bd673b5` | feat(finance): WP04 控制面激活接口、静默租约跨服务门禁与门禁收口 |
| `b9a1e84` | `9178dba` | chore(finance): 边界收口——WP01～WP04 GO/NO-GO 报告迁入 worktree |
| `0102309` | `61596d1` | feat(web): 资金账本初始化向导与状态切换（WP05 任务 5.1～5.5） |
| `94e7fc9` | `6bf8de5` | docs(evidence): WP05 GO/NO-GO 报告归档（GO，等待 WP06 授权） |
| `ddd1fc2` | `67457f4` | chore(evidence): WP05 边界恢复——越界记忆文件存档与报告更正 |
| `f6045a5` | `c58d84a` | test(verify): WP06 自动化验证（OpenSpec 6.1/6.2/6.4）与证据归档 |
| `05d1dc5` | `debcb2f` | test(wp07): 本地业务验收（OpenSpec 6.3）NO-GO 证据收口，HOLD 上报 D-1 |
| `7b2f80b` | `bdee2c8` | fix(finance): 迁移事件写入 legacy-purchase 来源标记（WP07 D-1） |
| `c9bc9b9` | `257088d` | test(wp07): 6.3 业务验收收敛 GO——D-1 正向门禁、充值侧防线与 v2 报告 |
| **`b22173f`** | **`df26a8c`** | docs(wp08): 收口 G-2 design.md 漂移并勾选 7.1～7.3 |
| **`5ac2881`** | **`7c2e5ca`** | test(wp08): 归档本地部署候选验证证据与 GO/NO-GO 报告（OpenSpec Phase 7） |
| **`ae202e1`** | **`94482f0`** | fix(finance): 收口 I1 复核 P1 代码类修复（F-P1-1～F-P1-6） |

加粗行为报告中被直接引用的关键提交号。完整 SHA：

- 旧 HEAD：`ae202e1aac9ea61de85a52850ba0fa004a8723b6`
- 新 HEAD：`94482f06e5ac69a80357b6e17b9786f7690265c4`

回退分支 `backup/finance-pre-i1-rebase` 指向旧 HEAD `ae202e1`，用于取证与对照，不参与交付。
