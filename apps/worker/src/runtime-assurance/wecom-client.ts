import {
  decodeKek,
  decryptCredential,
  type EncryptedCredential,
} from "@qianliu/provider-adapters";
import type { DeliveryContext } from "@qianliu/database";
import { availabilitySignalSummary, type UnifiedAvailabilitySignal } from "@qianliu/domain";
import { WECOM_API_ORIGIN } from "@qianliu/config";

const REQUEST_TIMEOUT_MS = 8_000;

export interface WecomResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
  msgid?: string;
  media_id?: string;
  invaliduser?: string;
  unlicenseduser?: string;
  invalidparty?: string;
  invalidtag?: string;
}

export interface WecomSendResult {
  status: "SENT" | "RETRYABLE_FAILED" | "PERMANENT_FAILED" | "SKIPPED";
  providerMessageId?: string;
  providerErrorCode?: string;
  classification?: string;
  invalidRecipients?: string[];
}

type FetchLike = typeof fetch;

function fixedMessage(context: DeliveryContext, detailUrl: string | null): string {
  if (context.delivery.delivery_type === "TEST") {
    return `【仟流智算】运行保障测试消息\n接收人：${context.person.name}\n结果：企微成员定向通道可用。`;
  }
  const event = context.event;
  if (!event) return "【仟流智算】运行保障事件数据不完整，请联系管理员。";
  const resource = event.upstream_model ?? event.provider_resource_id ?? "未知资源";
  const principal = context.principal?.name ?? context.person.name;
  const detail = detailUrl ?? `运行保障 > 熔断事件 > ${event.event_number}`;
  if (context.delivery.delivery_type === "RECOVERY") {
    const durationSeconds = event.recovered_at
      ? Math.max(0, Math.round((event.recovered_at.getTime() - event.started_at.getTime()) / 1_000))
      : null;
    return [
      "【仟流智算】运行保障恢复通知",
      `资源／模型：${resource}`,
      `影响主体：${principal}`,
      `恢复时间：${event.recovered_at?.toISOString() ?? "已恢复"}`,
      `持续时长：${durationSeconds === null ? "未知" : `${durationSeconds} 秒`}`,
      `影响请求：${event.affected_request_count}`,
      `事件编号：${event.event_number}`,
      `后台详情：${detail}`,
    ].join("\n");
  }
  return [
    "【仟流智算】运行保障熔断通知",
    `资源／模型：${resource}`,
    `原因：${availabilitySignalSummary(event.unified_signal as UnifiedAvailabilitySignal)}`,
    `影响主体：${principal}`,
    `开始时间：${event.started_at.toISOString()}`,
    `预计恢复：${event.recover_at?.toISOString() ?? "等待管理员处理"}`,
    "备用资源：由 Gateway 继续选择其他可用候选",
    `事件编号：${event.event_number}`,
    `后台详情：${detail}`,
  ].join("\n");
}

export function classify(code: number): WecomSendResult {
  if (code === 0) return { status: "SENT" };
  if ([-1, 40014, 42001, 45009, 40007, 42002].includes(code)) {
    return { status: "RETRYABLE_FAILED", providerErrorCode: String(code), classification: "WECOM_RETRYABLE" };
  }
  if ([60020, 60021, 60111, 81013, 82001].includes(code)) {
    return { status: "PERMANENT_FAILED", providerErrorCode: String(code), classification: "WECOM_RECIPIENT_NOT_VISIBLE" };
  }
  return { status: "PERMANENT_FAILED", providerErrorCode: String(code), classification: "WECOM_REJECTED" };
}

export interface EndpointConfig {
  id?: string;
  corp_id: string;
  agent_id: string;
  secret_ciphertext: string;
  secret_fingerprint: string;
}

export class WecomAppClient {
  readonly requestCounts = { token: 0, media: 0, message: 0 };
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly kekBase64: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly adminBaseUrl?: string,
  ) {}

  async send(context: DeliveryContext): Promise<WecomSendResult> {
    if (!context.identity || context.identity.status !== "ACTIVE") {
      return { status: "SKIPPED", classification: "RECIPIENT_IDENTITY_MISSING" };
    }
    if (context.endpoint.status !== "ACTIVE") {
      return { status: "SKIPPED", classification: "WECOM_ENDPOINT_DISABLED" };
    }
    try {
      let token = await this.getEndpointAccessToken(context.endpoint, false);
      let response = await this.postMessage(context, token);
      if (response.errcode === 40014 || response.errcode === 42001) {
        token = await this.getEndpointAccessToken(context.endpoint, true);
        response = await this.postMessage(context, token);
      }
      return parseMessageReceipt(response, [context.identity.provider_user_id]);
    } catch {
      return { status: "RETRYABLE_FAILED", classification: "WECOM_NETWORK_OR_PROTOCOL_ERROR" };
    }
  }

  async getEndpointAccessToken(endpoint: EndpointConfig, forceRefresh = false): Promise<string> {
    const key = `${endpoint.id ?? endpoint.corp_id}:${endpoint.secret_fingerprint}`;
    const cached = this.tokens.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now() + 60_000) return cached.token;
    const encrypted = JSON.parse(endpoint.secret_ciphertext) as EncryptedCredential;
    const secret = decryptCredential(encrypted, decodeKek(this.kekBase64));
    const url = new URL("/cgi-bin/gettoken", WECOM_API_ORIGIN);
    url.searchParams.set("corpid", endpoint.corp_id);
    url.searchParams.set("corpsecret", secret);
    const response = await this.fetchJson(url, { method: "GET" });
    if (response.errcode !== 0 || typeof response.access_token !== "string" || !response.access_token) {
      throw new WecomPreparationError(response.errcode === 0
        ? { status: "PERMANENT_FAILED", classification: "WECOM_INVALID_TOKEN_RECEIPT" } : classify(response.errcode ?? -1));
    }
    const expiresMs = Math.max(300_000, (response.expires_in ?? 7200) * 1000);
    this.tokens.set(key, { token: response.access_token, expiresAt: this.now() + expiresMs });
    return response.access_token;
  }

  async uploadMedia(
    endpoint: EndpointConfig,
    imageBuffer: Buffer,
    filename = "daily_report.png",
  ): Promise<string> {
    let token = await this.getEndpointAccessToken(endpoint, false);
    const doUpload = async (tok: string): Promise<WecomResponse> => {
      const url = new URL("/cgi-bin/media/upload", WECOM_API_ORIGIN);
      url.searchParams.set("access_token", tok);
      url.searchParams.set("type", "image");

      const boundary = `----WebKitFormBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
      const headerText = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="media"; filename="${filename.replace(/["\r\n]/g, "_")}"; filelength=${imageBuffer.length}`,
        `Content-Type: image/png`,
        "",
        "",
      ].join("\r\n");
      const header = Buffer.from(headerText, "utf-8");
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
      const body = Buffer.concat([header, imageBuffer, footer]);

      this.requestCounts.media++;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error("WECOM_MEDIA_HTTP_FAILED");
      return (await res.json()) as WecomResponse;
    };

    let response = await doUpload(token);
    if (response.errcode === 40014 || response.errcode === 42001) {
      token = await this.getEndpointAccessToken(endpoint, true);
      response = await doUpload(token);
    }

    if (response.errcode !== 0 || typeof response.media_id !== "string" || !response.media_id) {
      throw new WecomPreparationError(response.errcode === 0
        ? { status: "PERMANENT_FAILED", classification: "WECOM_INVALID_MEDIA_RECEIPT" } : classify(response.errcode ?? -1));
    }
    return response.media_id;
  }

  async sendImageMessage(
    endpoint: EndpointConfig,
    toUsers: string[],
    mediaId: string,
  ): Promise<WecomSendResult> {
    let token = await this.getEndpointAccessToken(endpoint, false);
    const doPost = async (tok: string): Promise<WecomResponse> => {
      const url = new URL("/cgi-bin/message/send", WECOM_API_ORIGIN);
      url.searchParams.set("access_token", tok);
      return this.fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: toUsers.join("|"),
          msgtype: "image",
          agentid: Number(endpoint.agent_id),
          image: { media_id: mediaId },
          safe: 0,
        }),
      });
    };

    let response = await doPost(token);
    if (response.errcode === 40014 || response.errcode === 42001) {
      token = await this.getEndpointAccessToken(endpoint, true);
      response = await doPost(token);
    }
    return parseMessageReceipt(response, toUsers);
  }

  async sendTextMessage(
    endpoint: EndpointConfig,
    toUsers: string[],
    content: string,
  ): Promise<WecomSendResult> {
    let token = await this.getEndpointAccessToken(endpoint, false);
    const doPost = async (tok: string): Promise<WecomResponse> => {
      const url = new URL("/cgi-bin/message/send", WECOM_API_ORIGIN);
      url.searchParams.set("access_token", tok);
      return this.fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: toUsers.join("|"),
          msgtype: "text",
          agentid: Number(endpoint.agent_id),
          text: { content },
          safe: 0,
        }),
      });
    };

    let response = await doPost(token);
    if (response.errcode === 40014 || response.errcode === 42001) {
      token = await this.getEndpointAccessToken(endpoint, true);
      response = await doPost(token);
    }
    return parseMessageReceipt(response, toUsers);
  }

  /** Report executor owns retries and counts each actual message request. */
  async sendReportMessage(endpoint: EndpointConfig, user: string,
    message: { kind: "IMAGE"; mediaId: string } | { kind: "TEXT"; content: string },
    beforeSend: () => Promise<boolean> = async () => true,
  ): Promise<ReportSendResult> {
    let token: string;
    try { token = await this.getEndpointAccessToken(endpoint); }
    catch (error) { return error instanceof WecomPreparationError ? error.result : { status: "RETRYABLE_FAILED", classification: "TOKEN_PREPARATION_FAILED" }; }
    if (!await beforeSend()) return { status: "RETRYABLE_FAILED", classification: "SEND_GUARD_CLOSED" };
    const url = new URL("/cgi-bin/message/send", WECOM_API_ORIGIN);
    url.searchParams.set("access_token", token);
    try {
      const response = await this.fetchJson(url, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
          touser: user, agentid: Number(endpoint.agent_id), safe: 0,
          msgtype: message.kind === "IMAGE" ? "image" : "text",
          ...(message.kind === "IMAGE" ? { image: { media_id: message.mediaId } } : { text: { content: message.content } }),
        }) });
      if (response.errcode === 40014 || response.errcode === 42001) {
        this.tokens.delete(`${endpoint.id ?? endpoint.corp_id}:${endpoint.secret_fingerprint}`);
      }
      return parseReportReceipt(response, user);
    } catch { return { status: "UNKNOWN", classification: "MESSAGE_RESPONSE_LOST_OR_INVALID" }; }
  }

  private async postMessage(context: DeliveryContext, token: string): Promise<WecomResponse> {
    const url = new URL("/cgi-bin/message/send", WECOM_API_ORIGIN);
    url.searchParams.set("access_token", token);
    return this.fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: context.identity!.provider_user_id,
        msgtype: "text",
        agentid: Number(context.endpoint.agent_id),
        text: { content: fixedMessage(context, this.eventDetailUrl(context.event?.id)) },
        safe: 0,
      }),
    });
  }

  private eventDetailUrl(eventId: string | undefined): string | null {
    if (!eventId || !this.adminBaseUrl) return null;
    try {
      const url = new URL("/runtime-assurance", this.adminBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.searchParams.set("tab", "events");
      url.searchParams.set("event", eventId);
      return url.toString();
    } catch {
      return null;
    }
  }

  private async fetchJson(url: URL, init: RequestInit): Promise<WecomResponse> {
    if (url.origin !== WECOM_API_ORIGIN) throw new Error("WECOM_HOST_NOT_ALLOWED");
    if (url.pathname.endsWith("/gettoken")) this.requestCounts.token++;
    if (url.pathname.endsWith("/message/send")) this.requestCounts.message++;
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error("WECOM_HTTP_FAILED");
    return await response.json() as WecomResponse;
  }
}

export type ReportSendResult = Omit<WecomSendResult, "status"> & {
  status: WecomSendResult["status"] | "UNKNOWN";
};
export class WecomPreparationError extends Error {
  constructor(readonly result: WecomSendResult) { super("WECOM_MEDIA_REJECTED"); }
}

export function parseReportReceipt(response: WecomResponse, user: string): ReportSendResult {
  if (!response || typeof response.errcode !== "number" || !Number.isInteger(response.errcode)) {
    return { status: "UNKNOWN", classification: "WECOM_INVALID_RECEIPT" };
  }
  if (response.errcode !== 0) return classify(response.errcode);
  const fields = [response.invaliduser, response.unlicenseduser, response.invalidparty, response.invalidtag];
  if (fields.some(value => value !== undefined && typeof value !== "string")) {
    return { status: "UNKNOWN", classification: "WECOM_INVALID_RECIPIENT_FIELDS" };
  }
  const rejected = `${response.invaliduser ?? ""}|${response.unlicenseduser ?? ""}`.split("|").filter(Boolean);
  if (rejected.some(item => item.toLowerCase() === user.toLowerCase())) {
    return { status: "PERMANENT_FAILED", classification: "WECOM_RECIPIENT_REJECTED", invalidRecipients: rejected };
  }
  if (rejected.length || response.invalidparty || response.invalidtag || typeof response.msgid !== "string" || !response.msgid) {
    return { status: "UNKNOWN", classification: "WECOM_UNATTRIBUTABLE_RECEIPT" };
  }
  return { status: "SENT", providerMessageId: response.msgid };
}

function parseMessageReceipt(response: WecomResponse, users: string[]): WecomSendResult {
  const rejected = typeof response?.invaliduser === "string" ? response.invaliduser : "";
  const unlicensed = typeof response?.unlicenseduser === "string" ? response.unlicenseduser : "";
  const invalid = `${rejected}|${unlicensed}`.split("|").filter(Boolean);
  if (invalid.length) return { status: "PERMANENT_FAILED", classification: "WECOM_PARTIAL_RECIPIENT_REJECTION", invalidRecipients: invalid };
  const result = parseReportReceipt(response, users[0] ?? "");
  // Existing alert/outbox callers have no UNKNOWN state and historically retry protocol failures.
  // Report sends use parseReportReceipt directly and retain UNKNOWN to prevent automatic replay.
  if (result.status === "UNKNOWN") return { ...result, status: "RETRYABLE_FAILED" };
  return { ...result, status: result.status };
}
