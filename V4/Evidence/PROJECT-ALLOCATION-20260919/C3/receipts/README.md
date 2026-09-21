# 红 Tested 对照回执元数据（WP07，2026-09-21）

原始输出含随机 UUID/时序/执行顺序，不做逐字节对比；可比对象 = 归一化失败用例清单（grep 'FAIL ' 提取、排序、diff）。

| 文件 | 代码 | 命令 | 退出码 |
| --- | --- | --- | --- |
| baseline-red-database.txt | 2b33719（重启基线，未含 C3） | vitest run standard-home + pool042 + exception-center | 1 |
| root-test-database.txt | 8a8cbe7（C3 当前） | pnpm --dir packages/database run test（全量） | 1 |
| baseline-red-gateway.txt | 2b33719 | vitest run pool043-operating-bill-settlement | 1 |
| root-test-gateway.txt | 8a8cbe7 | pnpm --dir apps/gateway run test | 1 |
| baseline-red-pool027.txt | 2b33719 | vitest run pool027-provider-model-discovery | 1 |
| root-test-controlapi.txt | 8a8cbe7 | pnpm --dir apps/control-api run test | 1 |
| root-test-domain.txt / root-test-worker.txt | 8a8cbe7 | 同名 test | 0（全绿） |
