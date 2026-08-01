# RA-W07 Web 一级模块 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 实现：左侧一级菜单“运行保障”；运行态势、可用性规则、熔断事件、异常中心、通知与人员五区；规则编辑派生新版、发布／停用／回滚；人员／主体负责人／userid／测试发送；旧 `/alerts` SPA 链接跳转到异常中心。
- 验证：Web 类型和 lint PASS；单测 53/53；Chromium E2E 22/22，含 `RA-WT-18`。
- 截图：`runtime-assurance-alerts.png`（临时本地 `_e2e` 数据库，无 Secret）。
- 风险：未在 Mac Mini 或真实管理员数据上进行页面签字。
- 结论：本地 Web 门禁 PASS。
