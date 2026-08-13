/**
 * W18 前端 API client —— 统一调 control-api 的 fetch 封装。
 *
 * 约定（与 W18 后端 commit 41e6eb8 对齐）：
 *   - cookie 会话（qianliu_admin_session），浏览器请求必须 credentials: "include"；
 *   - 业务错误体为扁平 { error, message }；401 由调用侧决定跳转登录；
 *   - 所有 API 请求统一加 /api 前缀：本地开发经 Vite proxy 代理到 127.0.0.1:8788
 *     （proxy 重写去掉 /api）；生产经 nginx 代理（nginx 去掉 /api 转发 control-api）。
 *     /api 前缀使 nginx 能区分 API 请求与 SPA 前端路由（两者路径可能重叠）。
 */

import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error ?? "unknown_error";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(body: ApiErrorBody | null) {
    super(401, body, "未登录或会话已过期");
    this.name = "UnauthorizedError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      signal,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, null, "无法连接到服务，请检查网络后重试");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401) {
      throw new UnauthorizedError(errorBody);
    }
    throw new ApiError(response.status, errorBody, `请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

export function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { signal });
}

export function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "POST", body, signal });
}

export function patch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "PATCH", body, signal });
}

export function put<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "PUT", body, signal });
}

export function del<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "DELETE", signal });
}

/** multipart 上传：浏览器自动生成 boundary，禁止手工设置 Content-Type。 */
export async function upload<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "POST", credentials: "include", body: form, signal,
  }).catch((cause: unknown) => {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, null, "无法连接到服务，请检查网络后重试");
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401) throw new UnauthorizedError(body);
    throw new ApiError(response.status, body, `上传失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function download(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api${path}`, { credentials: "include", signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401) throw new UnauthorizedError(body);
    throw new ApiError(response.status, body, `下载失败（${response.status}）`);
  }
  return response.blob();
}
