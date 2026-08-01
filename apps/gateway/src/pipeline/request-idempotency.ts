import { createHash } from "node:crypto";
import type { GatewayPipelineBody, NorthboundCapability } from "../routes/chat.js";

/**
 * 请求体指纹只用于判断同一业务幂等键是否代表同一请求。
 * 正文不落库，仅保存不可逆 SHA-256；对象键排序避免 JSON 属性顺序造成误冲突。
 */
export function fingerprintRequest(
  capability: NorthboundCapability,
  body: GatewayPipelineBody,
): string {
  const northboundBody = capability === "responses" ? body.responsesRequest : body;
  return createHash("sha256")
    .update(canonicalJson({ capability, body: northboundBody }))
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
