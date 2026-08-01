const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function configuredWebOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.WEB_ORIGIN;
  if (!raw) return [];
  return raw.split(",").map((item) => normalizeOrigin(item.trim()));
}

export function isCrossSiteMutation(input: {
  method: string;
  origin?: string;
  secFetchSite?: string;
  allowedOrigins: readonly string[];
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (input.secFetchSite === "cross-site") return true;
  if (!input.origin) return false;
  return !input.allowedOrigins.includes(input.origin);
}

function normalizeOrigin(value: string): string {
  if (!value) throw new Error("WEB_ORIGIN 含空值");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WEB_ORIGIN 仅支持 http/https");
  }
  if (url.origin !== value) {
    throw new Error(`WEB_ORIGIN 必须是纯 Origin（协议+主机+端口），不能含路径: ${value}`);
  }
  return url.origin;
}
