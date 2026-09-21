/** Administrator-initiated, single Chat request. Quota success never reaches this recovery path. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CredentialChatProbeRepository, CredentialProbeConflict, credentialProbeView } from "@qianliu/database";
import { canonicalProviderCode, capabilityConfiguredEndpoints, createOpenAiCompatibleCaller, decryptCredential, SecretValue, providerChatConfigHash, type HttpFetch } from "@qianliu/provider-adapters";
import type { Outcome } from "@qianliu/contracts";
import { requireAuth } from "../plugins/auth-guard.js";

const schema = z.object({ idempotency_key: z.string().uuid(), confirm_quota_consumption: z.literal(true) }).strict();
/** Chat 验证恢复支持的厂商集合（canonical code）。 */
const CHAT_PROBE_PROVIDER_CODES = new Set(["kimi", "zhipu", "deepseek"]);
/**
 * P1 整改：生产历史 Provider code 可能为 `Kimi`/`KIMI`/`DeepSeek` 等大小写变体，
 * 旧实现严格比较小写字面量，直接抛 provider_unsupported，导致凭证恢复链路
 * 在进入 caller 之前就被拒绝。统一先经 canonicalProviderCode 规范化，
 * 网关侧 auth_failure_config_hash（WP02 后同样以 canonical code 计算）因此可对齐。
 */
function providerCode(value: string): "kimi" | "zhipu" | "deepseek" {
  const canonical = canonicalProviderCode(value);
  if (CHAT_PROBE_PROVIDER_CODES.has(canonical)) return canonical as "kimi" | "zhipu" | "deepseek";
  throw new CredentialProbeConflict("provider_unsupported");
}
function configHash(provider: string, mode: string, model: string) {
  return providerChatConfigHash(providerCode(provider), mode, model);
}
const messages: Record<string, string> = {
  not_found: "资源不存在", not_isolated: "资源当前不是凭证隔离状态，请刷新页面",
  credential_missing: "资源尚未保存凭证，请先更新凭证",
  failure_model_unknown: "缺少原始鉴权失败模型，无法安全验证；请更新凭证后恢复",
  probe_cooldown: "验证正在进行或尚在冷却期，请五分钟后重试",
  provider_unavailable: "厂商已停用", provider_unsupported: "该厂商尚不支持 Chat 验证",
  probe_cancelled: "验证已取消，资源保持隔离",
  configuration_changed: "Chat 调用配置已改变，无法使用原故障证据恢复；请核对配置并更新凭证",
};

export function registerCredentialProbeRoutes(app: FastifyInstance) {
  const repo = new CredentialChatProbeRepository(app.db);
  app.get<{ Params: { id: string } }>("/provider-resources/:id/credential-probes", {
    preHandler: [requireAuth],
  }, async (req) => ({ probes: await repo.list(req.admin!.enterpriseId, req.params.id) }));
  app.post<{ Params: { id: string } }>("/provider-resources/:id/credential-probes", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "confirmation_required",
      message: "请确认本次验证会消耗少量厂商额度" });
    const abort = new AbortController();
    const cancel = () => { if (!reply.raw.writableEnded) abort.abort(); };
    req.raw.on("aborted", cancel);
    reply.raw.on("close", cancel);
    try {
      const started = await repo.begin({ enterpriseId: req.admin!.enterpriseId, resourceId: req.params.id,
        actorId: req.admin!.adminUserId, key: parsed.data.idempotency_key, configHash });
      if (started.replay) return { probe: credentialProbeView(started.probe) };
      let outcome: Outcome;
      try {
        const encrypted = JSON.parse(started.resource.credential_ciphertext!);
        const secret = new SecretValue(decryptCredential(encrypted, app.credentialKek));
        const caller = createOpenAiCompatibleCaller({ requestTimeoutMs: 60_000,
          firstByteTimeoutMs: 30_000, firstByteTimeoutMsForResource: () => 30_000,
          fetch: globalThis.fetch as unknown as HttpFetch });
        // P1/P2/RC-0：把 Provider capability_set 的 base_url 与模式专属
        // endpoints[mode] 一并交给统一的 Mode-aware 端点策略裁决。
        // Kimi CODING_PLAN 的历史 Moonshot 平台地址会被忽略并命中 Coding
        // 端点；显式配置的 endpoints.CODING_PLAN 优先命中；未知自定义域名
        // 则失败关闭（upstream_endpoint_ambiguous），不做任何静默回退。
        const configured = capabilityConfiguredEndpoints(started.provider.capability_set);
        outcome = await caller({ providerCode: providerCode(started.provider.code),
          resourceId: started.resource.id, mode: started.resource.mode,
          upstreamModel: started.probe.upstream_model, concurrencyLimit: 1,
          ...(configured.base_url ? { baseUrl: configured.base_url } : {}),
          ...(configured.endpoints ? { endpoints: configured.endpoints } : {}),
          secret }, {
          requestId: `credential-probe-${started.probe.id}`, capability: "chat",
          unifiedModel: started.probe.upstream_model, stream: false, abort: abort.signal,
          maxOutputTokens: 32,
          body: { messages: [{ role: "user", content: "Reply OK." }] },
        }, 1);
      } catch {
        outcome = { status: 0, committed: false, error: "probe_execution_failed",
          usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" } };
      }
      const probe = await repo.finish({ enterpriseId: req.admin!.enterpriseId, resourceId: req.params.id,
        probeId: started.probe.id, outcome, cancelled: () => abort.signal.aborted, configHash });
      return { probe };
    } catch (cause) {
      if (cause instanceof CredentialProbeConflict) return reply.code(cause.code === "not_found" ? 404 : 409)
        .send({ error: cause.code, message: messages[cause.code] ?? "验证条件已变化，请刷新后重试" });
      // Provider exceptions and DB errors can contain secrets; do not serialize their message.
      return reply.code(503).send({ error: "probe_unavailable", message: "验证结果暂时无法保存，资源不会因此自动解封；请稍后查看验证记录" });
    } finally {
      req.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    }
  });
}
