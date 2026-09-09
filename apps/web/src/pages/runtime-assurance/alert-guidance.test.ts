import { expect, it } from "vitest";
import { fault } from "./__tests__/fixture";
import { faultCategory, faultGuidance } from "./alert-guidance";
it.each([
  ["service_failure", "基础服务故障"],
  ["background_task_failure", "后台任务故障"],
  ["directory_task_failure", "后台任务故障"],
  ["quota_sync_failure", "后台任务故障"],
  ["request_failure", "模型调用失败"],
  ["TECHNICAL_FAILURE", "厂商/模型不可用"],
])(
  "names %s without treating quota usage as a fault category",
  (signal, label) => expect(faultCategory(fault({ signal }))).toBe(label),
);
it.each([
  [
    { alertKey: "SYSTEM_TASK:health:db" },
    "共享后台任务；不表示所有主体的调用均已失败",
    "任务下一次实际执行成功",
  ],
  [
    { signal: "quota_sync_failure" },
    "该资源的后台同步",
    "不需要因余额或额度使用率高",
  ],
  [
    { signal: "directory_task_failure", resourceId: null },
    "对应导入或同步任务",
    "重新执行任务并核对结果",
  ],
  [
    { signal: "call_deduction_anomaly" },
    "对应调用、计量或账本差异",
    "不要仅修改页面状态",
  ],
  [
    { domain: "CREDENTIAL_INVALID" as const },
    "该厂商资源的凭证或授权",
    "用对应资源验证一次调用",
  ],
  [
    { signal: "dispatch_anomaly" },
    "对应请求的调度决策",
    "历史决策不会因后续调用成功而改写",
  ],
  [
    { signal: "routing_anomaly" },
    "这次请求没有选出可调用资源",
    "原失败请求保留为历史记录",
  ],
  [
    { signal: "streaming_anomaly" },
    "关联的单次失败请求；不等于整个厂商不可用",
    "原请求的失败事实保持不变",
  ],
  [
    { signal: "request_failure" },
    "关联的单次失败请求；不等于整个厂商不可用",
    "打开关联请求核对错误码",
  ],
  [{}, "该厂商资源；具体受影响主体以关联请求为准", "可靠证据时确认恢复"],
  [
    { resourceId: null },
    "暂未关联具体资源，需进一步核对",
    "检查上游配置、凭证、限流或服务故障",
  ],
])(
  "explains the scope and actionable follow-up %#",
  (overrides, scope, advice) => {
    const actual = faultGuidance(fault(overrides));
    expect(actual.scope).toBe(scope);
    expect(actual.advice).toContain(advice);
  },
);
