# POC20-004A：Final Tag 容量阶梯复现入口

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 唯一产品候选 | `b3fb74b387ef61734d949be2e97fab7904bca959` |
| Final Tree | `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| 输入 Bundle | `81cc238f1b5e4bd75c3e54450d1c1bbec607e3cc0818283eb093fd12e95c8802` |
| 权威 Evidence | [Stage01/POC20-004](../../Evidence/Stage01/POC20-004/README.md) |

本轮 Gate 1 复验在 `git archive v1.0.0-final^{commit}` 的临时快照中顺序运行 Final Gateway 的 `50/20 → 100/50 → 500/200` 三档。三档功能与账本守恒均通过；只有 50/20 满足自增 TTFT P95≤150ms，因此标准版默认值仍冻结为 50/20，500/200 仍是 Gate 2 Stretch Goal。

Final archive 没有 `.git` 元数据，因此本轮没有调用会读取 Git 状态的 `run.sh`，而是在离线安装锁定依赖后，使用绝对路径直接运行 `gateway_capacity_check.ts` 三次。精确命令保存在原始 stdout；这避免把当前工作目录产品源码混进 Final Evidence。

1,000 万行数据库、备份和恢复部分使用本目录的代表性 Schema 与 Node 断言，不导入产品源码。本轮确认输入文件指纹未变化后复用已有结构化结果，没有伪造新的数据库执行时间或 stdout。原始 Final Gateway stdout、精确时间和合并口径见权威 Evidence。

输入 Bundle 只包含：

- `schema.sql`
- `database_capacity_check.cjs`
- `gateway_capacity_check.ts`
- `run.sh`

`README.md`、`result.json`、运行输出和容器数据均不参与输入 Bundle 指纹。
