import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { loadQuiescenceGate, type Database } from "@qianliu/database";

/**
 * Gateway 静默门禁（WP04 任务 4.5；PFA-09）。
 *
 * 激活前静默期内，目标企业不得再产生新的上游调用：新请求会写入 `ai_request` /
 * `upstream_attempt` / `usage_event` / `ledger_line`，让候选的事实水位持续漂移，
 * 排空永远无法完成。
 *
 * 因此本门禁挂在**模型调用端点**的 preHandler 上（chat / messages / responses），
 * 在 pipeline 之前短路：
 * - 不创建 `ai_request` 或任何 attempt/usage/ledger 事实；
 * - **不访问上游**；
 * - 返回明确的维护错误 `503 enterprise_maintenance`（`retryable=true`），
 *   与"上游临时故障"区分开，便于下游客户端按维护退避而不是切换账号。
 *
 * 已提交上游的请求不受影响：门禁只拦"新进请求"，不中止在途请求（PFA-09）。
 * `/v1/models` 等只读元数据端点不受门禁影响，控制台仍需能读取模型列表。
 *
 * 到期自动恢复：判定完全基于服务端当前时间（`ACTIVE AND expires_at > now`），
 * 租约到期或被解除后无需任何清理动作即可恢复流量。
 */
export function createQuiescenceGate(db: Kysely<Database>) {
  return async function requireEnterpriseNotQuiescent(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const principal = req.principal;
    if (!principal) return;
    const gate = await loadQuiescenceGate(db, principal.enterpriseId, new Date());
    if (!gate.quiescent) return;
    reply
      .code(503)
      .header("x-request-id", req.requestId)
      .header("retry-after", "60")
      .send({
        error: {
          message: "该企业正在进行资金账本初始化静默期，暂时停止新的模型调用，请稍后重试",
          type: "service_unavailable_error",
          code: "enterprise_maintenance",
          param: null,
          // 维护窗口结束后即可正常调用，属于可重试故障，但不做任何自动切换上游。
          retryable: true,
          request_id: req.requestId,
          maintenance_until: gate.expiresAt,
        },
      });
  };
}

/**
 * 组合两个认证/门禁处理器：前一个写入响应后不再执行后一个。
 *
 * Fastify 的 hook 运行器在 `reply` 已发送时会短路后续 hook，但这里显式判断，
 * 避免依赖框架内部行为——模型授权与维护门禁都必须"只答一次"。
 * 判断使用 `reply.sent`（Fastify 5 的公开语义：响应已发出），而不是探测
 * 底层 `reply.raw.writableEnded`——后者在 reply 已被序列化但 socket 尚未
 * flush 时可能仍为 false，导致双重应答。
 */
export function chainGuards(
  first: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  second: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    await first(req, reply);
    if (reply.sent) return;
    await second(req, reply);
  };
}
