import type { ProviderCode, ResourceMode } from "./model-discovery.js";
import { canonicalProviderCode } from "./provider-code.js";

export const PROVIDER_OPERATING_ADAPTER_VERSION = "pool20-025-v1";

export interface ProviderOperatingBalance {
  currency: string;
  totalBalance: string;
  grantedBalance: string | null;
  toppedUpBalance: string | null;
  available: boolean;
  providerDataAt: Date;
}

export class ProviderOperatingFactsError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOperatingFactsError";
  }
}

export type ProviderOperatingFetch = (
  input: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";

function decimal(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).trim();
  return /^\d+(?:\.\d+)?$/.test(value) ? value : null;
}

/**
 * 只读取厂商公开的经营事实。当前只有 DeepSeek API 公开余额接口；
 * 费用/充值流水接口不存在，由调用方显式记录 NOT_SUPPORTED，不能从本地余额倒推。
 */
export async function queryProviderOperatingBalance(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  fetch?: ProviderOperatingFetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<ProviderOperatingBalance | null> {
  // F-P2-7：canonical code 判定，生产历史 code（如 "DeepSeek"）不再静默跳过。
  if (canonicalProviderCode(input.providerCode) !== "deepseek" || input.mode !== "API") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetch ?? globalThis.fetch as unknown as ProviderOperatingFetch)(
      DEEPSEEK_BALANCE_ENDPOINT,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${input.credential}`, Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new ProviderOperatingFactsError("UNAUTHORIZED", "厂商拒绝当前凭证");
    }
    if (response.status === 429) {
      throw new ProviderOperatingFactsError("RATE_LIMITED", "厂商余额接口限流");
    }
    if (!response.ok) {
      throw new ProviderOperatingFactsError(
        response.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "INVALID_RESPONSE",
        `厂商余额接口返回 ${response.status}`,
      );
    }
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) {
      throw new ProviderOperatingFactsError("INVALID_RESPONSE", "厂商余额响应缺少必要字段");
    }
    const parsed = payload.balance_infos.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const currency = typeof row.currency === "string" ? row.currency.toUpperCase() : "";
      const totalBalance = decimal(row.total_balance);
      return currency && totalBalance ? [{
        currency,
        totalBalance,
        grantedBalance: decimal(row.granted_balance),
        toppedUpBalance: decimal(row.topped_up_balance),
      }] : [];
    });
    const selected = parsed.find((row) => row.currency === "CNY") ?? parsed[0];
    if (!selected) {
      throw new ProviderOperatingFactsError("INVALID_RESPONSE", "厂商余额响应没有可用币种余额");
    }
    return {
      ...selected,
      available: payload.is_available,
      providerDataAt: input.now ?? new Date(),
    };
  } catch (cause) {
    if (cause instanceof ProviderOperatingFactsError) throw cause;
    const timedOut = controller.signal.aborted;
    throw new ProviderOperatingFactsError(
      timedOut ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      timedOut ? "厂商余额查询超时" : "厂商余额接口不可用",
    );
  } finally {
    clearTimeout(timeout);
  }
}
