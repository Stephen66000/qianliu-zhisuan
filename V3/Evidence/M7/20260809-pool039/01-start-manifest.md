# POOL-039 开始 manifest

采集时间：2026-08-09；开始时工作树干净，`HEAD=main` 为：
`14938082c651fecb88b36589231a6241f9554510`。

开始时已存在文件（SHA-256）：

```text
5e3476509354c5e7182bc264e641f242988fe0b718e7d4f6745ef1636d99a47e  packages/database/src/repositories/employee-model-rule-repository.ts
e7d6f51fe3ae2beb9d32315890174a5c83aff66898423895701c2084772a8ca0  packages/database/src/repositories/principal-access-config-repository.ts
b6c42eb20846d648ef30fafe413d4b2c5e54df497a2bb9a483382888a692779b  apps/control-api/src/__tests-integration__/pool029-employee-model-rules.test.ts
72d5b144b517ed7ff3a45de33f6b49b171f470597a581a90e9f1fda38de9ec90  packages/database/src/__tests-integration__/billing-rule-multi-window-migration.integration.test.ts
cb0f8b4e71a5ce64603ce6c3c45a54ecaf0fbd537e610cd71d28553116e3371f  packages/database/src/__tests-integration__/principal-key-single-active-migration.integration.test.ts
325995db1d21a0ff05df18338e62dea0c5f92a2f85c96088b821f465cbaab2c0  packages/database/src/__tests-integration__/runtime-assurance-foundation.integration.test.ts
78f41c4efa0e279fd76beb801c99be94f95210b8d09b99d672eda76ce63e2673  V3/仟流智算-测试问题蓄水池.md
```

开始时 POOL-039 新文件均为 `ABSENT`：migration 0043、锁 helper、单人规则 helper、额度 helper、两个 POOL-039 integration test 文件。

保护边界核验：基线中无 `0044`，无 POOL-040～043 候选路径。
