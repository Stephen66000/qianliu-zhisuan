# WP02 实施记录 — 候选 C3

日期：2026-09-21。范围：v1.2 计划 §10 WP02（退出条件：重叠、超配、跨企业、并发、重复提交均可验证）。

## 1. 交付物

- 迁移 `0076_project_allocation_relations.js`（btree_gist、principal 复合唯一、核算生命周期、成员 stint+不可变修订+EXCLUDE+幂等键、规则集合版本+规则段）与 `0077_project_allocation_compute.js`（run/line/启用/脏代次/水位/资源余量/账单引用；run CHECK+终态不可变；line 目标触发器含 INSERT 事件；共享索引 IF NOT EXISTS、down 保守）。**C2 R1/R2 评审全部收紧前置**（同事务 dirty、复合 FK 全覆盖、原修订重放路径所需的幂等键结构、保守 down）。
- Kysely 类型 `kysely-allocation-tables.ts` + 注册。
- domain：`timeline.ts`/`policy.ts`（含 P2-1 `previewCapacity`）+ 13 个单测。
- 仓储 4 个：common（锁/解析/月份/脏标记/摘要）、policy（发布核心+预览+企业级时间线；dirty 同事务）、membership（加入/修订/列表；重放按原修订）、lifecycle（开始/结束+按序裁剪）。
- 集成测试 `project-allocation-foundation.integration.test.ts` **19 用例**：触发器合同与跨企业、M02 重叠/相邻/EXCLUDE/OCC、幂等重放（先修订再重放，P2-P1a 场景）、W01/W04 超配+预览（P2-1 口径断言 available=10000/remaining=6000）+并发、生命周期裁剪、run CHECK（INSERT/UPDATE 两路）与终态不可变、line 目标同企业 PROJECT、ref 跨企业+RESTRICT+不可变、修订链/操作者复合 FK、dirty 原子性（afterPublish 前置，非恒真）、月份口径、保守回退。
- 阶梯测试 18 文件扩链至 0077（python 批量，含 4 空格变体与 credential-probe 上层回退先行）。

## 2. 门禁回执（receipts/）

`typecheck.txt`（根 5 包 exit 0）、`lint.txt`（exit 0）、`wp02-integration.txt`（database 16 文件顺序全绿）、`wp02-integration-api.txt`（control-api 4 文件全绿 + foundation 19/19）、`domain-policy-test.txt`。

## 3. 实施要点（供 R01）

- 版本切换顺序：先关旧 is_current 再插新（部分唯一要求）。
- EXCLUDE 仅约束 ACTIVE 修订；负例测试用 SUPERSEDED 状态使复合 FK 成为被测约束。
- `assertNoActiveOverlap` 限定项目（跨项目参与不构成重叠）；infinity 用 `COALESCE($::timestamptz,'infinity')` 参数化。
- PG date 字面量需 `-01` 后缀；line 合同触发器挂 INSERT+UPDATE+DELETE。
- 预览 hidden 集在模块级权限下为空，字段与公式按合同保留（P2-1）。
