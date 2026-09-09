import type { AlertItem } from "../../api/types";
import { DOMAIN_LABEL } from "./alert-presenters";

export function faultCategory(alert: AlertItem): string {
  if (alert.signal === "service_failure") return "基础服务故障";
  if (
    alert.signal === "background_task_failure" ||
    alert.signal === "directory_task_failure" ||
    alert.signal.endsWith("sync_failure")
  )
    return "后台任务故障";
  if (alert.signal === "request_failure") return "模型调用失败";
  return DOMAIN_LABEL[alert.domain];
}

export function faultGuidance(alert: AlertItem) {
  if (alert.alertKey.startsWith("SYSTEM_TASK:"))
    return {
      scope: "共享后台任务；不表示所有主体的调用均已失败",
      advice:
        "检查对应任务日志及数据库、网络连接。任务下一次实际执行成功后，系统才记录恢复依据。",
    };
  if (
    alert.signal.endsWith("sync_failure") ||
    alert.signal === "directory_task_failure"
  )
    return {
      scope: alert.resourceId ? "该资源的后台同步" : "对应导入或同步任务",
      advice:
        "检查任务失败原因、厂商凭证和连接，重新执行任务并核对结果；不需要因余额或额度使用率高而处理。",
    };
  if (alert.signal === "call_deduction_anomaly")
    return {
      scope: "对应调用、计量或账本差异",
      advice:
        "核对请求、用量明细和结算记录，在对账流程中完成差异处理。不要仅修改页面状态来代替账本修正。",
    };
  if (alert.domain === "CREDENTIAL_INVALID")
    return {
      scope: "该厂商资源的凭证或授权",
      advice:
        "核对凭证、套餐有效期和模型授权；更新后用对应资源验证一次调用，并在说明中记录处理结果。",
    };
  if (alert.signal === "dispatch_anomaly")
    return {
      scope: "对应请求的调度决策",
      advice:
        "对比命中策略与实际动作、可切换资源及节省基线；记录原因和处理结论。历史决策不会因后续调用成功而改写。",
    };
  if (alert.signal === "routing_anomaly")
    return {
      scope: "这次请求没有选出可调用资源",
      advice:
        "检查模型路由、有效资源和授权。修正后重新调用，原失败请求保留为历史记录。",
    };
  if (
    alert.signal === "streaming_anomaly" ||
    alert.signal === "request_failure"
  )
    return {
      scope: "关联的单次失败请求；不等于整个厂商不可用",
      advice:
        "打开关联请求核对错误码、资源与调用过程。修正原因或重试后填写处理结论，原请求的失败事实保持不变。",
    };
  return {
    scope: alert.resourceId
      ? "该厂商资源；具体受影响主体以关联请求为准"
      : "暂未关联具体资源，需进一步核对",
    advice:
      "核对资源状态和关联请求；检查上游配置、凭证、限流或服务故障。仅当出现后续成功调用等可靠证据时确认恢复。",
  };
}
