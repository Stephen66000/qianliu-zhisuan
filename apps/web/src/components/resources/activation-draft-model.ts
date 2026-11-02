/**
 * 资金账本初始化草稿的纯模型（WP05 任务 5.2、5.5；PFU-02、PFU-05、PFH-01～PFH-03）。
 *
 * 本模块不含 React 与网络，只做「草稿行状态 → 请求载荷」的确定性转换与前置校验，
 * 便于对零值/空值、严格格式与行省略规则做单元测试。
 *
 * 校验分层（与 WP04 的 `activation-contracts.ts` 对齐，但**服务端始终是最终门禁**）：
 *  - 本地校验只拦「结构上无法构成合法请求体」的行，避免必然 400 的无效往返；
 *  - **业务缺口**（必要账户缺期初、旧记录未关闭、UNKNOWN_COST 等）一律交给服务端
 *    只读投影判定并返回结构化 `NO_GO`，本地不得替服务端下结论（PFU-03）。
 *
 * 零值 vs 空值（PFU-05、PFH-01 Scenario: Explicit zero opening）：
 *  - 金额填写 `0` 是**有效零值**，原样发送；
 *  - 金额留空表示**未填写**，绝不自动转换为 `0`；整行内容皆空时整行省略，
 *    由服务端投影给出 `MISSING_OPENING_BALANCE` 缺口。
 *
 * 历史 API 充值行（充值表单最小修复 2026-09-27）：
 *  - 管理员只填六项：厂商资源、币种、到账金额、人民币实付、充值时间、充值订单号；
 *  - 事实说明、证据引用、来源旧记录与记录级幂等键由服务端自动生成，载荷不再携带；
 *  - 草稿内检查同一厂商资源下充值订单号不得重复（数据库唯一索引兜底）。
 *
 * 历史 API 消耗行（0084，2026-09-27 最小增量）：
 *  - 管理员只填四项：厂商资源、币种、实际消耗金额（界面输入正数）、成本截止时间；
 *  - 期间开始固定使用资金切换时点，不提供输入框；
 *  - 服务端把正数规范化为负向资金事实（account_amount = -cost_amount），
 *    并按资源、币种、切换时点、截止时间、金额确定性生成说明/证据/幂等键。
 */

// 保留原调用入口；各职责模块独立持有状态、校验与载荷转换。
export {
  ACTIVATION_SCHEMA_VERSION, ACTIVATION_DESCRIPTION_MAX_LENGTH,
  ACTIVATION_EVIDENCE_MAX_LENGTH, ACTIVATION_MAX_DRAFT_ROWS,
  ACTIVATION_EXTERNAL_REFERENCE_MAX_LENGTH, ACTIVATION_REASON_MAX_LENGTH,
  ACTIVATION_RECORD_KEY_MIN_LENGTH, ACTIVATION_RECORD_KEY_MAX_LENGTH,
  DRAFT_SECTION_LABELS, newLocalRowId, newRecordIdempotencyKey,
  emptyDraftState, countActiveRows,
  type FinanceCurrencyCode, type PurchaseKind, type OpeningRowState,
  type RechargeRowState, type HistoricalCostRowState, type PurchaseRowState,
  type CarryoverRowState, type LegacyRowState, type ActivationDraftState,
  type DraftSection, type DraftIssue,
} from "./activation-draft-state";
export {
  isValidAccountAmount, isValidCashPaidCny, isValidShanghaiDay, isValidUuid,
  toInstant, validateOpeningRow, validateRechargeRow, validateHistoricalCostRow,
  validatePurchaseRow, validateCarryoverRow, validateLegacyRow, validateDraft,
} from "./activation-draft-validation";
export { buildActivationDraft } from "./activation-draft-payload";
