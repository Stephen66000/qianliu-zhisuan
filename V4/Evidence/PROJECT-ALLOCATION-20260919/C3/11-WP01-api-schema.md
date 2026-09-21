# WP01 接口 Schema 与权限映射（冻结）— 候选 C3

约定（基线实测）：路由根作用域+`preHandler:[requireAuth]`；分页 `limit/offset`+`total`；错误 `{error,message,…extras}` snake_case；审计 `auditRepo.write`（action `project_allocation.<entity>.<verb>`）。

## 1. 权限映射（P2-2 冻结：无新权限实体）

| 操作 | 权限 |
| --- | --- |
| 成员/生命周期/规则 写入、企业级完整规则集合 读+提交 | `principals` operate（企业级入口读写均 operate） |
| 成员/历史/员工规则时间线 读 | `principals` view |
| 规则预览返回金额 | `principals` operate **且** `billing` view |
| 项目账列表/详情/明细/未分配/状态 GET | `billing` view |
| 手工重建/促发、启用登记 POST | `billing` operate |
| 系统任务 | 非 API；actor=SYSTEM |

A01 负例：企业级入口无 operate → 403；跨企业/类型不符 → 统一 404（`not_found`，不泄露存在性）；只读角色写操作 → 403。

## 2. 主体类型解析器

`resolveAllocationPrincipal(enterpriseId, id, expectedType)`：`enterprise_id+id+type` 查询；不存在/跨企业/类型不符统一 `PrincipalNotAccessibleError`→404。适用于全部新端点与请求体内员工 ID。

## 3. 端点（合同 10 §1 的操作面）

| 端点 | 方法/权限 | 响应要点 |
| --- | --- | --- |
| `/principals/:projectId/project-memberships` | GET / principals view | rows（员工、区间、当前权重、其他项目占比、状态 ACTIVE/FUTURE/ENDED）+counts{current,at?,period?}（按员工去重）+total/limit/offset |
| 同上 | POST / operate | body：employeePrincipalId、joinedAt(ISO/日期)、leftAt?、weight?{weightBps,validFrom?,validUntil?}、expectedPolicyVersion?、reason、idempotencyKey；返回 {membershipId,revision,policyVersion?,affectedMonths}；幂等重放返回原结果（原修订区间） |
| `/:membershipId/revisions` | POST / operate | {expectedRevision,joinedAt?,leftAt?,reason,idempotencyKey}→{revision,affectedMonths}；409 membership_revision_conflict{latestRevision} |
| `/accounting-lifecycle-revisions` | POST / operate | {effectiveAt,reason,expectedVersion}→{version,mode,affectedEmployees,affectedMonths}；不改 status/Key |
| `/principals/:employeeId/project-allocation-policy` | GET / **principals operate** | 完整时间线+当前版本；403/404 负例见 §1 |
| `…/project-allocation-intents/preview` | POST / principals operate（含金额另验 billing view） | {visibleRules[],hidden{hidden_project_count,hidden_weight_bps,available_bps,remaining_bps},conflicts[],segments[{weightBps,availableBpsBefore,resultingRemainingBps}],affectedMonths}（P2-1 口径） |
| `…/project-allocation-intents/versions` | POST / operate | {employeePrincipalId,segments,expectedPolicyVersion,reason,idempotencyKey}→{policyVersion,affectedMonths}；409 allocation_policy_conflict{latestPolicyVersion,retryPreview:true} |
| `GET /operating-bills/:month/projects`（兼容升级） | billing view | 旧行为/字段不变；新增 allocation{runId,computedAt,status,totals} 与顶层 allocationStatus/unallocated 汇总 |
| `…/projects/:projectId/allocation-lines` | billing view | 固定 runId+稳定排序分页；源行与份额字段并列；筛选 employee_id/source |
| `…/project-unallocated` | billing view | totals{tokens,byReason,apiCostByCurrency,packageCostCny}+lines+resourceResidual |
| `…/project-allocation-status` | billing view | {enabled,currentRun{status,computedAt,stale(由 dirty 代次推导),completeness},lastError?}；无批次不返回假 0 |
| `…/project-allocation-runs` | POST / billing operate | {reason,idempotencyKey}→202 {runId,status}；已关闭账期 409 period_closed；已有活动任务返回其状态 |
| `…/project-allocation-enablement` | POST / billing operate | {startMonth,reason}；同事务登记初始化任务；幂等 |

## 4. 错误码

`invalid_request`(400)、`invalid_interval`(400)、`rule_coverage_invalid`(400+conflicts)、`weight_exceeded`(400+conflicts/availableBps)、`not_found`(404 统一)、`allocation_policy_conflict`(409+latest)、`membership_revision_conflict`(409)、`accounting_version_conflict`(409)、`period_closed`(409)、`allocation_not_ready`/`allocation_stale`(409)、`allocation_run_conflict`(409)。幂等重放=200 原结果。

## 5. Web 落点

新 hooks 独立文件（`project-members.ts`/`project-allocation.ts`）；`OperatingBillProjects.tsx` 原位升级+`/operating-bill/projects/:principalId` 详情路由；详情页成员贡献/分段/明细/未分配；分页 limit/offset searchParams；文案含"依据管理规则归集，不代表实际工作内容""不设置规则仍可正常使用 AI"。
