# POOL-039 结束 manifest

- 结束时间：2026-08-09（Asia/Shanghai）
- 基线：`main` / `14938082c651fecb88b36589231a6241f9554510`
- 候选数：47；下列规范化清单聚合 SHA-256：`ac2aedfe2668795e2d20207445edf86e29ee6b172dff1f2425d454139e799809`
- `git diff --check`：通过。
- 边界：未发现 0044 或 POOL-040～043 候选；未改变 POOL-033/035/038 已关闭业务语义。
- Git/发布写操作：未 stage、commit、push、merge、创建 PR 或部署。
- 本证据目录不纳入代码 manifest，避免自引用；开始 manifest 保持原样。

| SHA-256 | 文件 |
|---|---|
| `3c5803055c1e8ed131efd0c31e99e3a2169a4eb1f49cc0861a082b6d9efe4b07` | `V3/仟流智算-测试问题蓄水池.md` |
| `e40538ab856cb2e04121e9e2920e29d299ba0c563cc224d58d4710b6c3af23b0` | `apps/control-api/src/__tests-integration__/pool027-provider-model-discovery.test.ts` |
| `31ec6a2cea3be16082c413ad9204ec7f949358f469dfe9c01fd013e81b6e5c14` | `apps/control-api/src/__tests-integration__/pool029-employee-model-rules.test.ts` |
| `ed3f9efa8b9dc799959b782d382eba4ad655469653c8c150a500974c84685177` | `apps/control-api/src/__tests-integration__/pool039-lock-order.test.ts` |
| `b488786af4ca79f4a71281a95d915718171b57bc5844393433fba0a557690ef0` | `apps/control-api/src/admin-writes/routes.ts` |
| `874910dae689d0cffeadc18a2d0b4b052778cee82193fa4f0f137ecdfe70dbc3` | `apps/control-api/src/admin-writes/types.ts` |
| `7c864baf756dcbce6b4997b7e1eb548151e244c0a9d9fb7a51e3024a48a68516` | `apps/gateway/src/pipeline/real-pipeline.ts` |
| `5e157e9e9fda252a1f047e965ab083cd0db05ad22d3c0930b7de19f79ed6624b` | `apps/gateway/stryker.pool039.config.json` |
| `718422c4a552c657e35b0bc7049ccb49b16435b3b0ad3bc1d5ce5d604367fc73` | `apps/gateway/vitest.pool039.mutation.config.ts` |
| `ca1ece457c8dc9e6824fe75b17e257648d6e56af2938cc14e0976412539e7aa4` | `apps/web/src/api/employee-model-rules.test.tsx` |
| `ca92a3975f5bb0306f0a16fcc5ddb3d1f0b1ee5cde2ef0d95237ffffe220f383` | `apps/web/src/api/reporting-types.ts` |
| `4f1263f58aa6195de0c707dde209dbb8d243aa9bd6c3c3e45df3db6eb9a8a76c` | `apps/web/src/api/types.ts` |
| `c31d6c81d05aa601c696ea9da0ed059ce370a2688e42515359df5c7bf9805042` | `apps/web/src/components/layout/Sidebar.test.tsx` |
| `33ca8fa0ebe7f7f8bc43bfc0f909d9230e788a5b0ec698268281c7fa9c48d9ba` | `apps/web/src/pages/EmployeeModelRules.test.tsx` |
| `03fbba57952e3f259343780d03dc5be4b1fa8a8b5cec09ec342d28d14378be4f` | `package.json` |
| `f116a7309ad580b8593332ebadb5cb9d742891d4c738dde4a83354ce6fc207af` | `packages/database/migrations/0043_single_owner_rule_history.js` |
| `db0fc55cdb2ca305ee0add0b1deaa4ab0603228c739c00659e9a3ce63b3da32c` | `packages/database/src/__tests-integration__/billing-rule-multi-window-migration.integration.test.ts` |
| `c059682ca31695a6d1a9d59e8c55bd447c9b935f86b352dd87f10cc669f7369e` | `packages/database/src/__tests-integration__/pool039-lock-order-migration.integration.test.ts` |
| `d7c49fd4693b91dc0db3c4063be94285f3c25a253ea2755c51370604b0b03cbd` | `packages/database/src/__tests-integration__/principal-key-single-active-migration.integration.test.ts` |
| `a3433f89a94c2957bd8f6f7cf792015429983e433278723c989e7dc6249b692a` | `packages/database/src/__tests-integration__/runtime-assurance-foundation.integration.test.ts` |
| `06d4502fe7f38d73ff870b1116e601d424eba2b659f1ab46a363ce1b92f3284a` | `packages/database/src/employee-model-rule-types.ts` |
| `a31c96ce52678a6ef0915f45dae3015a673c8999cd8c54810189e5321c71811a` | `packages/database/src/kysely-availability-tables.ts` |
| `7f76231ce6ecd60a91b28a35265bc4108b4803c6635efd25448845d4f79c3eaf` | `packages/database/src/kysely.ts` |
| `93d99612aec3d97108fb8cb02d896c57f2f1832b17d3337ac196237e01033b85` | `packages/database/src/repositories/dashboard-overages.mutation.test.ts` |
| `5a42ad0e80e22ee7eea0bf8c43e1bb501d691058ee3ffcfd5ee618dcec66f650` | `packages/database/src/repositories/dashboard-overages.ts` |
| `3137da41fbe6205017c8d5f784e58c25ecfc9d500675fdc25c1b7c6076df1156` | `packages/database/src/repositories/dashboard-repository.ts` |
| `dece9b09c29eb9be7f490bee7ee147b992360afabf217ac98fc28749bd90bf1f` | `packages/database/src/repositories/employee-model-rule-lifecycle.mutation.test.ts` |
| `8d05daf7512b9123fdd743a62a0fa47fd058b3f51ee76f110be58703f474362f` | `packages/database/src/repositories/employee-model-rule-lifecycle.ts` |
| `f8f2c2e2f694cb0b3f099ab55a543f1efce4898713592bdc880a59dd640468ff` | `packages/database/src/repositories/employee-model-rule-lock-context.ts` |
| `6f602d93916a05d8de0b06d63452341097ee3957fa103829588197611053f7ca` | `packages/database/src/repositories/employee-model-rule-quota.ts` |
| `dd57e3a1d5485dd1087d25894fe49763dea67f1838874902ba90f80b467275a4` | `packages/database/src/repositories/employee-model-rule-repository.mutation.test.ts` |
| `dfaa3734000d99cf7e97389c83a86794bbad08dc692ae246b5c9dbe06d3410e2` | `packages/database/src/repositories/employee-model-rule-repository.ts` |
| `b373be333618c58f9ce085f7e15c4d2a67314a3604b436f7664ba29836f4705c` | `packages/database/src/repositories/pool039-repositories.mutation.test.ts` |
| `c2190aa631a25fd93ee3a43c31622088a9927480b2641a6c3eb82f64a3b77304` | `packages/database/src/repositories/principal-access-config-repository.mutation.test.ts` |
| `4880f63cc7c7ffa00857e1c9c16d048a4854ce3a410518f6c2ee7f6a8128340e` | `packages/database/src/repositories/principal-access-config-repository.ts` |
| `7d38594d19f8ef146464090161596a1179e23e26616f4e5492124d13652b098e` | `packages/database/src/repositories/principal-access-locks.mutation.test.ts` |
| `9509d77f75823132f0279615bd6777884642186e3863e973825272f27ecbb830` | `packages/database/src/repositories/principal-access-locks.ts` |
| `93965744d53c9cb79405fec03f97c771f22fa66b6a6aca337536bb795f2c5156` | `packages/database/src/repositories/principal-access-read-model.mutation.test.ts` |
| `de319402fd27b97a5d138851703f3aaa40efdae63e5da3a1a577dcccf96b9928` | `packages/database/src/repositories/principal-access-read-model.ts` |
| `b6559f15aa7043119af6114c5766ba0d258497e5792bb39f8e3346b00b271656` | `packages/database/src/repositories/principal-single-rule.ts` |
| `0f9423a856bb739eaed34043149df1ab32ec2b39ae5d9535067922e95e4a9a4d` | `packages/database/stryker.pool039.config.json` |
| `fabbc88eb34a40cd8f14d921143456cf97318caf9a911c4c71081dd01f5d9937` | `packages/database/vitest.pool039.mutation.config.ts` |
| `e8d8ee9a274b49e9f07d8c5d65dcde0a150b64f341091adadce976a818a72daa` | `packages/domain/reports/mutation/mutation.html` |
| `3c7f7ca2d4b926c1b17c380c82945bb613e22e8e39931b03b99cf57439e39c1d` | `packages/domain/reports/mutation/mutation.json` |
| `8a5450471074c56c967bdbe6e2dc08e9dce59ab98733f993b81261160e8dd04d` | `packages/provider-adapters/src/openai-compatible-caller.ts` |
| `a0adc38cd84a143d501bbc294fa760535817219b092731d944295f23e894dfbb` | `packages/provider-adapters/src/openai-compatible-types.ts` |
| `0a887b2a13b1481b2fb923da289902f5bb23403da88baadef2e5c60216884a1d` | `vitest.pool029.config.ts` |
