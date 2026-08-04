/** POOL-028：版本化客户端身份识别。只识别观测事实，不参与鉴权或计费。 */
export const CLIENT_IDENTITY_RULE_VERSION = "2026-08-03.v1" as const;

export type AgentFamily = "WORKBUDDY" | "CODEX" | "ZCODE" | "CLAUDE_CODE" | "QIANLIU_IDE" | "OTHER" | "UNKNOWN";
export type AgentIdentitySource = "DECLARED_HEADER" | "VERIFIED_USER_AGENT" | "PROTOCOL_FEATURE" | "NONE";
export type AgentIdentityConfidence = "DECLARED" | "OBSERVED" | "LIMITED" | "UNKNOWN";

export interface ClientIdentity {
  rawClientId: string | null;
  family: AgentFamily;
  version: string | null;
  source: AgentIdentitySource;
  confidence: AgentIdentityConfidence;
  ruleVersion: string;
}

export interface ClientIdentityInput {
  headers: Record<string, unknown>;
  protocol: "chat" | "messages" | "responses";
  url?: string;
}

const FAMILY_PATTERNS: Array<{ family: AgentFamily; pattern: RegExp }> = [
  { family: "WORKBUDDY", pattern: /\bwork[\s_-]?buddy\b/i },
  { family: "CODEX", pattern: /\bcodex(?:_cli_rs)?\b/i },
  { family: "ZCODE", pattern: /\bz[\s_-]?code\b/i },
  { family: "CLAUDE_CODE", pattern: /\bclaude[\s_-]?code\b/i },
  { family: "QIANLIU_IDE", pattern: /\b(?:qianliu|仟流)[\s_-]?(?:ide|agent)\b/i },
];

function headerValue(headers: Record<string, unknown>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

function safeRaw(value: string): string | null {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/(?:authorization|cookie|bearer\s|sk-[a-z0-9]|\/Users\/|[A-Z]:\\)/i.test(normalized)) return null;
  return normalized.slice(0, 64);
}

function familyOf(value: string): AgentFamily | null {
  return FAMILY_PATTERNS.find(({ pattern }) => pattern.test(value))?.family ?? null;
}

function versionOf(value: string): string | null {
  const match = value.match(/(?:^|[\s/_-])v?(\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?)/);
  return match?.[1]?.slice(0, 32) ?? null;
}

export function identifyClient(input: ClientIdentityInput): ClientIdentity {
  const declared = safeRaw(headerValue(input.headers, "x-client-id"));
  if (declared) return {
    rawClientId: declared,
    family: familyOf(declared) ?? "OTHER",
    version: versionOf(declared),
    source: "DECLARED_HEADER",
    confidence: "DECLARED",
    ruleVersion: CLIENT_IDENTITY_RULE_VERSION,
  };

  const userAgent = safeRaw(headerValue(input.headers, "user-agent"));
  const userAgentFamily = userAgent ? familyOf(userAgent) : null;
  if (userAgent && userAgentFamily) return {
    rawClientId: userAgent,
    family: userAgentFamily,
    version: versionOf(userAgent),
    source: "VERIFIED_USER_AGENT",
    confidence: "OBSERVED",
    ruleVersion: CLIENT_IDENTITY_RULE_VERSION,
  };

  let clientVersion: string | null = null;
  if (input.url) {
    try { clientVersion = new URL(input.url, "http://gateway.local").searchParams.get("client_version"); }
    catch { clientVersion = null; }
  }
  if (clientVersion && input.protocol === "responses") return {
    rawClientId: userAgent,
    family: "CODEX",
    version: safeRaw(clientVersion)?.slice(0, 32) ?? null,
    source: "PROTOCOL_FEATURE",
    confidence: "LIMITED",
    ruleVersion: CLIENT_IDENTITY_RULE_VERSION,
  };

  return {
    rawClientId: userAgent,
    family: userAgent ? "OTHER" : "UNKNOWN",
    version: userAgent ? versionOf(userAgent) : null,
    source: userAgent ? "VERIFIED_USER_AGENT" : "NONE",
    confidence: userAgent ? "LIMITED" : "UNKNOWN",
    ruleVersion: CLIENT_IDENTITY_RULE_VERSION,
  };
}
