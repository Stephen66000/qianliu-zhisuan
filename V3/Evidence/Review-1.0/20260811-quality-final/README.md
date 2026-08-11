# Final 候选质量门禁 Evidence

## 最终结果

`corepack pnpm@11.11.0 run quality` 最终完整退出码为 `0`，日志为 `quality-final-pass.log`。

- Node v22.17.1，pnpm 11.11.0；
- 1006 项基础测试通过；
- 11 个工作区构建通过；
- 13 个覆盖率 ratchet 范围无下降；
- 架构、源码体量、重复率、依赖漏洞、许可证和日志 canary 门禁通过。

## 中间失败的处置

1. `quality.log`：版本常量升到 1.0.0 后旧测试仍断言 0.3.0，修正断言；
2. `quality-rerun.log`：并发行锁观测出现一次时序超时；`concurrency-recheck.log` 单独 57／57 通过；
3. `quality-final.log`：coverage ratchet 要求 POOL-040，但聚合脚本漏跑；补 `quality:coverage:pool040`；
4. `quality-continuation.log`：缺口修复后覆盖率与全部后置门禁通过；
5. `quality-final-pass.log`：修复后的完整质量命令最终 PASS。

中间失败不删除，作为 Review 真实过程保留。

