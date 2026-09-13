import {
  decodeKek,
  decryptCredential,
  type EncryptedCredential,
} from "@qianliu/provider-adapters";
import type { DeliveryContext } from "@qianliu/database";
import { availabilitySignalSummary, type UnifiedAvailabilitySignal } from "@qianliu/domain";

const WECOM_API_ORIGIN = "https://qyapi.weixin.qq.com";
const REQUEST_TIMEOUT_MS = 8_000;

interface WecomResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
  msgid?: string;
  media_id?: string;
}

export interface WecomSendResult {
  status: "SENT" | "RETRYABLE_FAILED" | "PERMANENT_FAILED" | "SKIPPED";
  providerMessageId?: string;
  providerErrorCode?: string;
  classification?: string;
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

function classify(code: number): WecomSendResult {
  if (code === 0) return { status: "SENT" };
  if ([-1, 40014, 42001, 45009].includes(code)) {
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
      const result = classify(response.errcode ?? -1);
      return response.errcode === 0 ? { ...result, providerMessageId: response.msgid } : result;
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
    if (response.errcode !== 0 || !response.access_token) throw new Error("WECOM_TOKEN_REJECTED");
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
        `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${imageBuffer.length}`,
        `Content-Type: image/png`,
        "",
        "",
      ].join("\r\n");
      const header = Buffer.from(headerText, "utf-8");
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
      const body = Buffer.concat([header, imageBuffer, footer]);

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      return (await res.json()) as WecomResponse & { media_id?: string };
    };

    let response = await doUpload(token);
    if (response.errcode === 40014 || response.errcode === 42001) {
      token = await this.getEndpointAccessToken(endpoint, true);
      response = await doUpload(token);
    }

    if (response.errcode !== 0 || !response.media_id) {
      throw new Error(`WECOM_MEDIA_UPLOAD_FAILED: ${response.errmsg ?? response.errcode}`);
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
    const result = classify(response.errcode ?? -1);
    return response.errcode === 0 ? { ...result, providerMessageId: response.msgid } : result;
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
    const result = classify(response.errcode ?? -1);
    return response.errcode === 0 ? { ...result, providerMessageId: response.msgid } : result;
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
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return await response.json() as WecomResponse;
  }
}
