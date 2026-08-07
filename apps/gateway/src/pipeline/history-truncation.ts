/**
 * 历史截断 / token 预算（安全网，默认关闭）。
 *
 * 防御超大请求：当北向 messages[] 累积上下文明显偏大时，保留 system + 末尾
 * 一段历史，从中间丢弃，避免撞上游上下文上限并节省额度。默认不启用——
 * 必须由运维显式配置 GATEWAY_HISTORY_TRUNCATE_AT_TOKENS +
 * GATEWAY_HISTORY_KEEP_TOKENS 两个 env（成对）才生效；未配置时零行为变化。
 *
 * 仅作用于 chat / messages 协议的 messages[]；Responses 暂不截断。
 * 不依赖 tokenizer——用字符数 / 4 粗估（与 estimateRawTokens 同口径，仅 input）。
 */
import type { FastifyBaseLogger } from "fastify";

/** 截断配置；null 表示不启用。 */
export interface TruncationConfig {
  /** 触发阈值：估算 input token 超过此值才裁剪。 */
  truncateAtTokens: number;
  /** 裁后保留量：保留 system + 末尾累计到约此 token 数的非 system 消息。 */
  keepTokens: number;
}

/**
 * 从环境变量读取截断配置。两个 env 必须成对设置才启用：
 *   GATEWAY_HISTORY_TRUNCATE_AT_TOKENS —— 触发阈值（正整数）
 *   GATEWAY_HISTORY_KEEP_TOKENS       —— 裁后保留量（正整数，须 < 触发阈值）
 * 都未设 → 返回 null（不启用，零行为变化）。
 * 非法值或仅设其一 → 启动期抛错（fail-fast，避免半启用导致行为不可预期）。
 */
export function readTruncationConfig(env: NodeJS.ProcessEnv): TruncationConfig | null {
  const rawAt = env.GATEWAY_HISTORY_TRUNCATE_AT_TOKENS;
  const rawKeep = env.GATEWAY_HISTORY_KEEP_TOKENS;
  const atUnset = rawAt === undefined || rawAt === "";
  const keepUnset = rawKeep === undefined || rawKeep === "";

  if (atUnset && keepUnset) return null; // 默认关闭
  if (atUnset !== keepUnset) {
    throw new Error(
      "GATEWAY_HISTORY_TRUNCATE_AT_TOKENS 与 GATEWAY_HISTORY_KEEP_TOKENS 必须成对设置（仅设其一不启用截断）",
    );
  }

  const truncateAtTokens = Number(rawAt);
  const keepTokens = Number(rawKeep);
  if (!Number.isSafeInteger(truncateAtTokens) || truncateAtTokens <= 0) {
    throw new Error("GATEWAY_HISTORY_TRUNCATE_AT_TOKENS 必须是正整数");
  }
  if (!Number.isSafeInteger(keepTokens) || keepTokens <= 0) {
    throw new Error("GATEWAY_HISTORY_KEEP_TOKENS 必须是正整数");
  }
  if (keepTokens >= truncateAtTokens) {
    throw new Error(
      "GATEWAY_HISTORY_KEEP_TOKENS 必须小于 GATEWAY_HISTORY_TRUNCATE_AT_TOKENS（否则永远不触发裁剪）",
    );
  }
  return { truncateAtTokens, keepTokens };
}

/** 单条消息 input token 估算（字符数 / 4，无 output reserve）。 */
function estimateMessageTokens(message: unknown): number {
  try {
    return Math.ceil(JSON.stringify(message).length / 4);
  } catch {
    return 8; // 序列化失败的兜底（与 estimateRawTokens 的 32 兜底同量级，/4）
  }
}

/** OpenAI chat 消息的工具调用字段类型守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 提取 assistant 消息的 tool_calls id 集合（无则空）。 */
function assistantToolCallIds(message: unknown): Set<string> {
  if (!isRecord(message) || message.role !== "assistant") return new Set();
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return new Set();
  const ids = new Set<string>();
  for (const c of calls) {
    if (isRecord(c) && isRecord(c.function) && typeof c.id === "string") ids.add(c.id);
  }
  return ids;
}

/** 提取 tool 角色消息的 tool_call_id（无则 null）。 */
function toolCallIdOf(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "tool") return null;
  return typeof message.tool_call_id === "string" ? message.tool_call_id : null;
}

/**
 * 截断北向 messages。返回新数组，不改原数组。
 *
 * 算法：
 * 1. 估算总量；未超 truncateAtTokens → 原样返回（正常请求零影响）。
 * 2. 超 → 分离 system（全保留）+ 非 system。
 * 3. 从非 system 末尾倒序累加 token 到 keepTokens，得到保留段下标 [start, end)。
 * 4. tool 配对保护：若保留段开头是孤立的 tool 消息（其 assistant tool_calls 被截掉），
 *    向前跳过整组孤立的 tool 消息；若开头 assistant 的 tool_calls 响应落在保留段外，
 *    同理把该 assistant 一起丢弃（保持配对完整）。
 * 5. 极端兜底：单条就超阈值时仍保留末尾第一条 + system。
 */
export function truncateHistory(
  messages: unknown[],
  config: TruncationConfig,
): unknown[] {
  if (messages.length === 0) return messages;

  const totalTokens = messages.reduce<number>((sum, m) => sum + estimateMessageTokens(m), 0);
  if (totalTokens <= config.truncateAtTokens) return messages; // 未超阈值，零改动

  const systemMessages: unknown[] = [];
  const conversation: unknown[] = [];
  for (const m of messages) {
    if (isRecord(m) && m.role === "system") systemMessages.push(m);
    else conversation.push(m);
  }

  if (conversation.length === 0) return messages; // 只有 system，无需裁

  // 从末尾倒序累加到 keepTokens，确定保留起点。
  let acc = 0;
  let start = conversation.length; // 保留 [start, length)
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (acc >= config.keepTokens) break;
    acc += estimateMessageTokens(conversation[i]);
    start = i;
  }

  // tool 配对保护：跳过开头孤立的 tool 消息（对应 assistant 被截掉）。
  // 同时若保留段第一条 assistant 带了 tool_calls，但其部分响应被截，
  // 不强制丢弃该 assistant——保留段内若有该 id 的 tool 响应即视为配对完整。
  // 这里只处理"开头是孤立 tool 消息"这一最常见的破坏点。
  while (start < conversation.length) {
    const first = conversation[start];
    const toolId = toolCallIdOf(first);
    if (toolId === null) break; // 非 tool 消息，无需跳过
    // 这条 tool 消息对应的 assistant 是否在保留段内？
    let matched = false;
    for (let j = start + 1; j < conversation.length; j++) {
      if (assistantToolCallIds(conversation[j]).has(toolId)) {
        matched = true;
        break;
      }
    }
    if (matched) break; // 配对完整，停止跳过
    start++; // 孤立 tool，丢弃
  }

  // 兜底：跳过后保留段空了（极端情况），至少保留最后一条。
  if (start >= conversation.length) start = conversation.length - 1;

  const retained = conversation.slice(start);
  return [...systemMessages, ...retained];
}

/**
 * Pipeline 调用入口：对北向 body 做截断（同步、无副作用）。
 * 返回截断后的 messages（或原数组）；若发生实际裁剪，记 info 日志便于运维观测。
 * 仅对 messages[] 生效；调用方负责只在 chat/messages 协议调用。
 */
export function applyHistoryTruncation(
  messages: unknown[],
  config: TruncationConfig | null,
  log?: FastifyBaseLogger,
  requestId?: string,
): unknown[] {
  if (config === null) return messages;
  // 复用单次估算（C-1：原实现 truncateHistory 内部会再算一遍同样总量）。
  const beforeTokens = messages.reduce<number>((s, m) => s + estimateMessageTokens(m), 0);
  // F-1：超阈值但全部是 system（无可裁内容）时显式 warn，避免运维观测盲区。
  if (beforeTokens > config.truncateAtTokens) {
    const hasNonSystem = messages.some((m) => !isRecord(m) || m.role !== "system");
    if (!hasNonSystem) {
      log?.warn(
        { requestId, tokens: beforeTokens, threshold: config.truncateAtTokens, messages: messages.length },
        "请求估算 token 超阈值但全部为 system 消息，无可裁剪内容，原样透传",
      );
    }
  }
  const truncated = truncateHistory(messages, config);
  if (truncated !== messages) {
    const afterTokens = truncated.reduce<number>((s, m) => s + estimateMessageTokens(m), 0);
    log?.info(
      { requestId, before: { messages: messages.length, tokens: beforeTokens }, after: { messages: truncated.length, tokens: afterTokens } },
      "历史截断已触发（保留 system + 末尾历史，中间丢弃）",
    );
  }
  return truncated;
}

/**
 * 构造发给上游 + 额度预占共用的 effectiveBody（G-3：预占与发送口径一致）。
 *
 * chat/messages：对 body.messages 应用截断（截断启用且超阈值时裁剪），返回新对象；
 * Responses：原样返回 body（不截断）。
 * 截断默认关闭（config=null）时，chat/messages 也原样返回（messages 可能被
 * 替换成 [] 仅当 body.messages 非数组——与既有兜底一致）。
 *
 * 返回值同时用于 adapter.invoke 的 body 和 reserveQuota 的 estimatedCost，
 * 保证"预占的量"与"实际发送的量"基于同一份 body。
 */
export function buildEffectiveBody<B extends { messages?: unknown[] }>(
  body: B,
  capability: "chat" | "messages" | "responses",
  config: TruncationConfig | null,
  log?: FastifyBaseLogger,
  requestId?: string,
): B {
  if (capability !== "chat" && capability !== "messages") return body;
  const messages = applyHistoryTruncation(
    Array.isArray(body.messages) ? body.messages : [],
    config,
    log,
    requestId,
  );
  return { ...body, messages };
}
