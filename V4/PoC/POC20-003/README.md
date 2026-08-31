# POC20-003：Final Tag 账期并发复现入口

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 唯一产品候选 | `b3fb74b387ef61734d949be2e97fab7904bca959` |
| Final Tree | `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| 输入 Bundle | `8e120072948093658496888b63c719e019d38c3dc2c8321950a4a3a9a6500751` |
| 权威 Evidence | [Stage01/POC20-003](../../Evidence/Stage01/POC20-003/README.md) |

本目录只有代表性 2.0 Overlay、Fixture 和断言程序，不含产品实现。2026-08-11 的 Gate 1 复验先用 `git archive v1.0.0-final^{commit}` 解出只读产品快照，再把本目录复制到临时快照执行；没有使用当前工作目录产品源码。

Final 测试文件含 35 个静态 `it/test` 声明，Vitest 参数化展开后实际运行 `57/57`；随后 Overlay 状态机、并发锁、水位、幂等和恢复断言全部通过。原始 stdout 和精确时间见权威 Evidence。

输入 Bundle 只包含：

- `fixture.sql`
- `overlay.sql`
- `run.sh`
- `state_machine_check.cjs`

`README.md`、`result.json`、运行输出和容器数据均不参与输入 Bundle 指纹。
