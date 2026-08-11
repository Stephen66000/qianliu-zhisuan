# 初始候选质量验证 Evidence

| 字段 | 内容 |
| --- | --- |
| 候选 | `7ec225ba11068d4b40b92d3a9cc9c01a1e23d13b`＋Review 文档草案 |
| 执行日 | 2026-08-11（Asia/Shanghai） |
| 性质 | 整改前首轮诊断，不是 Final 门禁 |

## 已观察结果

- 依赖安装：锁文件冻结安装成功；供应链策略检查 862 条通过。
- TypeScript：通过。
- ESLint：通过。
- 第一次测试：本机 Docker 未启动，17 个 Testcontainers suite 统一报 `Could not find a working container runtime strategy`；这是环境失败。
- 启动 Docker Desktop 后，全量测试重跑通过：10 个工作区测试包、1006 个测试全部通过；原始日志见 `test-rerun.log`。
- 全量构建重跑通过：11 个工作区构建全部通过；原始日志见 `build-rerun.log`。
- Web 构建有一个非阻断提示：主 JS 633.08 kB（gzip 179.44 kB）超过 Vite 默认 500 kB 提示线，登记为 2.0 性能债，不阻断 1.0 封板。
- `test-rerun.log` 与首次 `build.log` 的命令包装层曾报告 Node v24.14.0 / pnpm 11.16.0；当前工作区复核为 Node v22.17.1，且 `corepack pnpm@11.11.0` 可用。Final 门禁统一使用明确版本命令，避免环境歧义。

## 首轮结论

`PASS_WITH_FOLLOW_UP`：候选代码的类型、规范、测试与构建基线成立；待完成版本身份、必要文档同步和风险点抽查后，在 Final 候选上重跑门禁。

最终结果必须在代码语义标注、版本和文档整改后的 Final 候选上重新生成。
