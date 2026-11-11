/**
 * 初始化草稿编辑器（WP05 任务 5.2；PFU-02、PFU-05、PFH-01～PFH-03）。
 *
 * WP4-S3 / AFR-01 场景3：API 资金草稿区（API 期初余额、历史 API 充值、历史 API 消耗）
 * 的编辑 UI 已退役——后端预检合同为纯套餐（`activation-contracts.ts` 对三类 API 草稿键
 * 任一非空显式拒绝），前端不再提供会产生必然失败的表单。Coding Plan 购买/续费、
 * 跨切换周期与旧记录关闭（AFR-04：套餐初始化不受 API 退役影响）保持原样。
 * API 数据结构的类型/序列化层保留（`activation-draft-state.ts` 等），用于历史本机草稿
 * 兼容：旧草稿中的 API 行仍可恢复并进入校验，需通过「清除本机草稿」处置。
 * 约定：
 *  - 金额空值与 `0` 严格区分：留空显示「未填写」且不自动补 0（PFU-05）；
 *  - 说明与证据引用对购买与跨切换周期必填（PFH-06）；
 *  - `UNKNOWN_COST` 不是本编辑器可以关闭的对象，只能走既有的历史费用处置闭环（PFH-02）。
 */

import { FormField, INPUT_CLASS } from "../writes/FormField";
import { MoneyAmountInput } from "../writes/MoneyAmountInput";
import {
  DRAFT_SECTION_LABELS, newRecordIdempotencyKey,
  type ActivationDraftState, type CarryoverRowState, type DraftIssue, type DraftSection,
  type LegacyRowState, type PurchaseRowState,
} from "./activation-draft-model";
import { Button } from "../ui/Button";
import { CurrencySelect, ResourceSelect, DraftSectionCard, RowShell } from "./ActivationDraftControls";

export interface ResourceOption { id: string; mode: "API" | "CODING_PLAN"; label: string }

export interface LegacySuggestion { legacyRecordId: string; resourceId: string }

interface EditorProps {
  state: ActivationDraftState;
  onChange: (next: ActivationDraftState) => void;
  resourceOptions: ResourceOption[];
  issues: DraftIssue[];
  readOnly: boolean;
  legacySuggestions: LegacySuggestion[];
}

function errorFor(issues: DraftIssue[], section: DraftSection, rowId: string, field: string): string | undefined {
  return issues.find((issue) => issue.section === section && issue.rowId === rowId
    && (issue.field === field || issue.field === "rows"))?.message;
}

function updateRow<TRow extends { id: string }>(
  rows: TRow[], id: string, patch: Partial<TRow>,
): TRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function PurchaseRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: PurchaseRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<PurchaseRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `purchase-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`Coding Plan ${index + 1}`}>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-kind`} label="登记类型">
        <select className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-kind`} onChange={(event) => onPatch({ kind: event.target.value as PurchaseRowState["kind"] })} value={row.kind}>
          <option value="PURCHASE">首次购买</option><option value="RENEWAL">续费</option>
        </select>
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "productName")} htmlFor={`${rowId}-product`} label="产品名称">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-product`} onChange={(event) => onPatch({ productName: event.target.value })} value={row.productName} />
      </FormField>
      <FormField htmlFor={`${rowId}-currency`} label="币种">
        <CurrencySelect disabled={readOnly} id={`${rowId}-currency`} onChange={(value) => onPatch({ accountCurrency: value })} value={row.accountCurrency} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "accountAmount")} hint="原币金额，最多八位小数" htmlFor={`${rowId}-amount`} label="订阅金额">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-amount`} onChange={(value) => onPatch({ accountAmount: value })} value={row.accountAmount} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "cashPaidCny")} hint="必须大于 0" htmlFor={`${rowId}-cash`} label="人民币实付">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-cash`} onChange={(value) => onPatch({ cashPaidCny: value })} value={row.cashPaidCny} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "servicePeriodStart")} hint="页面为包含结束日的上海自然日" htmlFor={`${rowId}-start`} label="服务开始日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-start`} onChange={(event) => onPatch({ servicePeriodStart: event.target.value })} type="date" value={row.servicePeriodStart} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "servicePeriodEnd")} hint="留空按“下个月同日前一日”" htmlFor={`${rowId}-end`} label="服务结束日（可选）">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-end`} onChange={(event) => onPatch({ servicePeriodEnd: event.target.value })} type="date" value={row.servicePeriodEnd} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "occurredAt")} hint="必须等于服务开始日" htmlFor={`${rowId}-occurred`} label="扣费时间">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-occurred`} onChange={(event) => onPatch({ occurredAtLocal: event.target.value })} type="datetime-local" value={row.occurredAtLocal} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "externalReference")} htmlFor={`${rowId}-reference`} label="外部引用">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-reference`} onChange={(event) => onPatch({ externalReference: event.target.value })} value={row.externalReference} />
      </FormField>
      <label className="flex items-center gap-2 text-[13px]" htmlFor={`${rowId}-renew`}>
        <input checked={row.autoRenew} disabled={readOnly} id={`${rowId}-renew`} onChange={(event) => onPatch({ autoRenew: event.target.checked })} type="checkbox" />自动续订
      </label>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "description")} htmlFor={`${rowId}-description`} label="事实说明">
          <textarea className={`${INPUT_CLASS} min-h-16 w-full py-2`} disabled={readOnly} id={`${rowId}-description`} onChange={(event) => onPatch({ description: event.target.value })} value={row.description} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "evidenceRef")} htmlFor={`${rowId}-evidence`} label="证据引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
        </FormField>
      </div>
    </RowShell>
  );
}

function CarryoverRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: CarryoverRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<CarryoverRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `carryover-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`跨切换周期 ${index + 1}`}>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "productName")} htmlFor={`${rowId}-product`} label="产品名称">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-product`} onChange={(event) => onPatch({ productName: event.target.value })} value={row.productName} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "periodStart")} htmlFor={`${rowId}-start`} label="周期开始日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-start`} onChange={(event) => onPatch({ periodStart: event.target.value })} type="date" value={row.periodStart} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "periodEnd")} htmlFor={`${rowId}-end`} label="周期结束日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-end`} onChange={(event) => onPatch({ periodEnd: event.target.value })} type="date" value={row.periodEnd} />
      </FormField>
      {/* 管理员声明路径（2026-09-27 最小兼容修复）：每行只有四项输入。
          快照引用/事实说明/证据引用不再向管理员展示——说明与证据由服务端按
          资源、产品、周期确定性生成；隐藏字段保留在行状态里以兼容
          localStorage v1 已保存草稿的完整恢复，但不进入预检载荷。 */}
    </RowShell>
  );
}

function LegacyRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: LegacyRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<LegacyRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `legacy-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`旧记录关闭 ${index + 1}`}>
      <FormField error={errorFor(issues, "legacyResolutions", row.id, "legacyRecordId")} hint="原旧购买记录引用" htmlFor={`${rowId}-record`} label="旧购买记录">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-record`} onChange={(event) => onPatch({ legacyRecordId: event.target.value })} value={row.legacyRecordId} />
      </FormField>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-resolution`} label="关闭结果">
        <select className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-resolution`} onChange={(event) => onPatch({ resolution: event.target.value as LegacyRowState["resolution"] })} value={row.resolution}>
          <option value="MIGRATED">MIGRATED（迁移为资金事件）</option>
          <option value="ALREADY_REPRESENTED">ALREADY_REPRESENTED（已由既有事件表达）</option>
          <option value="REJECTED_WITH_EVIDENCE">REJECTED_WITH_EVIDENCE（有证据地拒绝）</option>
        </select>
      </FormField>
      {row.resolution === "MIGRATED" ? (
        <FormField error={errorFor(issues, "legacyResolutions", row.id, "migratedExternalReference")} hint="迁移后的外部订单引用" htmlFor={`${rowId}-migrated`} label="外部订单引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-migrated`} onChange={(event) => onPatch({ migratedExternalReference: event.target.value })} value={row.migratedExternalReference} />
        </FormField>
      ) : null}
      {row.resolution === "ALREADY_REPRESENTED" ? (
        <FormField error={errorFor(issues, "legacyResolutions", row.id, "financeEventId")} hint="必须引用同企业同资源的资金事件" htmlFor={`${rowId}-event`} label="资金事件 ID">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-event`} onChange={(event) => onPatch({ financeEventId: event.target.value })} value={row.financeEventId} />
        </FormField>
      ) : null}
      {row.resolution === "REJECTED_WITH_EVIDENCE" ? (
        <>
          <FormField error={errorFor(issues, "legacyResolutions", row.id, "reason")} hint="必填：说明该记录为何不是实际资金事实" htmlFor={`${rowId}-reason`} label="拒绝原因">
            <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-reason`} onChange={(event) => onPatch({ reason: event.target.value })} value={row.reason} />
          </FormField>
          <FormField error={errorFor(issues, "legacyResolutions", row.id, "evidenceRef")} hint="必填" htmlFor={`${rowId}-evidence`} label="拒绝证据">
            <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
          </FormField>
          <p className="text-[13px] text-ql-warning md:col-span-2">
            该决定只关闭这条旧购买记录；<code>UNKNOWN_COST</code> 用量缺口仍必须独立处理，不能借此关闭。
          </p>
        </>
      ) : null}
      {row.resolution === "MIGRATED" ? (
        <p className="text-[13px] text-ql-fg-tertiary md:col-span-2">
          MIGRATED 会写入 <code>API_RECHARGE</code> 事件，服务端对引用 API_RECHARGE 旧记录的候选按
          退役 API 资金事实拒绝（AFR-01 场景3）；引用前请先确认该记录仍属可迁移口径。
        </p>
      ) : null}
    </RowShell>
  );
}

export function ActivationDraftEditor({
  state, onChange, resourceOptions, issues, readOnly, legacySuggestions,
}: EditorProps) {
  const setSection = <TKey extends keyof ActivationDraftState>(key: TKey, rows: ActivationDraftState[TKey]) =>
    onChange({ ...state, [key]: rows });

  const patch = <TRow extends { id: string }>(key: keyof ActivationDraftState, id: string,
    change: Partial<TRow>) => {
    const rows = state[key] as unknown as TRow[];
    setSection(key, updateRow(rows, id, change) as unknown as ActivationDraftState[typeof key]);
  };

  const removeRow = <TRow extends { id: string }>(key: keyof ActivationDraftState, id: string) => {
    const rows = state[key] as unknown as TRow[];
    setSection(key, rows.filter((row) => row.id !== id) as unknown as ActivationDraftState[typeof key]);
  };

  const planOptions = resourceOptions.filter((option) => option.mode === "CODING_PLAN");
  const unclosedSuggestions = legacySuggestions.filter((suggestion) => !state.legacyResolutions.some(
    (row) => row.legacyRecordId === suggestion.legacyRecordId));

  return (
    <div data-testid="activation-draft-editor">
      <DraftSectionCard
        addLabel="添加购买/续费" count={state.codingPlanPurchases.length}
        description="Coding Plan 购买或续费：服务开始日/结束日为上海自然日（页面含结束日），扣费时间必须等于开始日。"
        onAdd={() => setSection("codingPlanPurchases", [...state.codingPlanPurchases, {
          id: newLocalRowIdFor("purchase"), resourceId: "", kind: "RENEWAL", productName: "",
          accountAmount: "", accountCurrency: "CNY", cashPaidCny: "", servicePeriodStart: "",
          servicePeriodEnd: "", occurredAtLocal: "", externalReference: "", autoRenew: true,
          description: "", evidenceRef: "", sourceRecordId: "", carryoverSnapshotId: "",
          recordIdempotencyKey: newRecordIdempotencyKey(),
        }])}
        readOnly={readOnly} testId="draft-section-purchases" title={DRAFT_SECTION_LABELS.codingPlanPurchases}
      >
        {state.codingPlanPurchases.map((row, index) => (
          <PurchaseRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<PurchaseRowState>("codingPlanPurchases", row.id, change)}
            onRemove={() => removeRow("codingPlanPurchases", row.id)}
            readOnly={readOnly} resourceOptions={planOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加跨切换周期" count={state.codingPlanCarryovers.length}
        description="覆盖切换时点的历史套餐周期：重叠周期只有在历史用量仍能唯一归属时才可存在。"
        onAdd={() => setSection("codingPlanCarryovers", [...state.codingPlanCarryovers, {
          id: newLocalRowIdFor("carryover"), resourceId: "", productName: "", periodStart: "",
          periodEnd: "", snapshotId: "", description: "", evidenceRef: "",
        }])}
        readOnly={readOnly} testId="draft-section-carryovers" title={DRAFT_SECTION_LABELS.codingPlanCarryovers}
      >
        {state.codingPlanCarryovers.map((row, index) => (
          <CarryoverRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<CarryoverRowState>("codingPlanCarryovers", row.id, change)}
            onRemove={() => removeRow("codingPlanCarryovers", row.id)}
            readOnly={readOnly} resourceOptions={planOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加旧记录关闭" count={state.legacyResolutions.length}
        description="切换时点后的每条旧购买记录必须有唯一关闭结果：MIGRATED、ALREADY_REPRESENTED 或 REJECTED_WITH_EVIDENCE。"
        onAdd={() => setSection("legacyResolutions", [...state.legacyResolutions, {
          id: newLocalRowIdFor("legacy"), legacyRecordId: "", resourceId: "", resolution: "MIGRATED",
          financeEventId: "", migratedExternalReference: "", reason: "", evidenceRef: "",
        }])}
        readOnly={readOnly} testId="draft-section-legacy" title={DRAFT_SECTION_LABELS.legacyResolutions}
      >
        {unclosedSuggestions.length > 0 ? (
          <div className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[13px] text-ql-warning" data-testid="legacy-suggestions">
            预检发现 {unclosedSuggestions.length} 条未关闭旧记录：
            {unclosedSuggestions.map((suggestion) => (
              <Button variant="secondary" size="sm"
                className="ml-2"
                key={suggestion.legacyRecordId}
                onClick={() => setSection("legacyResolutions", [...state.legacyResolutions, {
                  id: newLocalRowIdFor("legacy"), legacyRecordId: suggestion.legacyRecordId,
                  resourceId: suggestion.resourceId, resolution: "MIGRATED", financeEventId: "",
                  migratedExternalReference: "", reason: "", evidenceRef: "",
                }])}
                type="button"
              >
                补齐 {suggestion.legacyRecordId.slice(0, 8)}
              </Button>
            ))}
          </div>
        ) : null}
        {state.legacyResolutions.map((row, index) => (
          <LegacyRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<LegacyRowState>("legacyResolutions", row.id, change)}
            onRemove={() => removeRow("legacyResolutions", row.id)}
            readOnly={readOnly} resourceOptions={resourceOptions} row={row}
          />
        ))}
      </DraftSectionCard>
    </div>
  );
}

function newLocalRowIdFor(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
