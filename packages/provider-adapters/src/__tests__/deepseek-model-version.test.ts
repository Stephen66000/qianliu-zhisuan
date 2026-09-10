import { beforeEach, expect, it, vi } from "vitest";
import { clearProviderModelDiscoveryCache, discoverProviderModels } from "../model-discovery.js";
import { DEEPSEEK_VERSION_URL, parseDeepSeekVersions } from "../deepseek-model-version.js";
import type { DiscoveryFetch, DiscoveryResponse } from "../model-discovery-contract.js";

const html = `<table><thead><tr><th>模型</th><th><strong>deepseek-v4-flash</strong></th>
<th>deepseek-v4-pro</th><th>deepseek-v4-flash-vision-exp</th></tr></thead><tbody>
<tr><td>BASE URL</td><td colspan="3">https://api.deepseek.com</td></tr>
<tr><td>模型版本</td><td>DeepSeek-V4-Flash-0731</td><td>DeepSeek-V4-Pro-0813</td>
<td>DeepSeek-V4-Flash-Vision-Exp</td></tr></tbody></table>`;
const ids = ["deepseek-v4-flash", "deepseek-v4-pro"];
const checkedAt = new Date("2026-09-10T00:00:00Z");
const doc = (text = html): DiscoveryResponse => ({ ok: true, status: 200, url: DEEPSEEK_VERSION_URL,
  headers: { "content-type": "text/html" }, text: async () => text });
function fetcher(document: () => Promise<DiscoveryResponse> = async () => doc()) {
  return vi.fn<DiscoveryFetch>(async (url) => url === "https://api.deepseek.com/models"
    ? { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) }
    : document());
}
const discover = (fetch: DiscoveryFetch, extra = {}) => discoverProviderModels({
  providerCode: "deepseek", mode: "API", credential: "private-key", now: checkedAt, fetch, ...extra,
});
beforeEach(clearProviderModelDiscoveryCache);

it("按表头关联版本：保留API调用名，官网多列模型不扩充账号可用目录", async () => {
  const fetch = fetcher(), result = await discover(fetch);
  expect(result.models.map((model) => model.id)).toEqual(ids);
  expect(result.models.map((model) => model.displayName)).toEqual(ids);
  expect(result.models.map((model) => model.facts.officialVersion)).toEqual(["DeepSeek-V4-Flash-0731", "DeepSeek-V4-Pro-0813"]);
  expect(result.models[0]!.facts.fieldEvidence.official_version).toEqual([{
    url: DEEPSEEK_VERSION_URL, checkedAt: checkedAt.toISOString(), extractedValue: "DeepSeek-V4-Flash-0731",
  }]);
  expect(result.source).toBe("PROVIDER_API");
  expect(result.sourceVersion).toBe("deepseek-list-models-v2");
  const [, options] = fetch.mock.calls.find(([url]) => url === DEEPSEEK_VERSION_URL)!;
  expect(options.headers).not.toHaveProperty("authorization");
  expect(options.redirect).toBe("error");
  expect(JSON.stringify(options)).not.toContain("private-key");
});

it.each([
  ["HTML", html],
  ["Markdown", "| MODEL | deepseek-v4-flash | deepseek-v4-pro |\n| MODEL VERSION | DeepSeek-V4-Flash-0731 | DeepSeek-V4-Pro-0813 |"],
])("解析 %s 官方表格而非硬编码日期", (_kind, source) => {
  expect(parseDeepSeekVersions(source).get("deepseek-v4-flash")).toBe("DeepSeek-V4-Flash-0731");
  expect(parseDeepSeekVersions(source.replaceAll("0731", "1015")).get("deepseek-v4-flash")).toBe("DeepSeek-V4-Flash-1015");
});

it.each([
  ["普通正文", "deepseek-v4-flash 的新版是 DeepSeek-V4-Flash-0731"],
  ["脚本内容", `<script>${html}</script>`],
  ["错列", html.replace("DeepSeek-V4-Flash-0731", "DeepSeek-V4-Pro-0813")],
  ["同前缀Vision错列", html.replace("DeepSeek-V4-Flash-0731", "DeepSeek-V4-Flash-Vision-Exp")],
  ["同前缀Vision带日期错列", html.replace("DeepSeek-V4-Flash-0731", "DeepSeek-V4-Flash-Vision-Exp-0910")],
  ["列数变化", html.replace("<td>DeepSeek-V4-Flash-0731</td>", "")],
  ["冲突", html + html.replace("0731", "0901")],
])("%s 不猜测版本", (_kind, source) => {
  expect(parseDeepSeekVersions(source).has("deepseek-v4-flash")).toBe(false);
});

it.each([
  ["不可用", async () => ({ ok: false, status: 503 })],
  ["超时", async () => { throw new Error("timeout"); }],
  ["错误域名", async () => ({ ...doc(), url: "https://evil.example/prices" })],
  ["非文本", async () => ({ ...doc(), headers: { "content-type": "image/png" } })],
  ["过大", async () => ({ ...doc(), headers: { "content-type": "text/html", "content-length": "5000000" } })],
  ["未列版本", async () => doc("<p>暂未公布模型版本</p>")],
] as const)("版本来源%s不阻断API目录、不谎报版本", async (_reason, load) => {
  const result = await discover(fetcher(load));
  expect(result.models.map((model) => model.id)).toEqual(ids);
  expect(result.stale).toBe(false);
  expect(result.models.every((model) => model.facts.officialVersion === null)).toBe(true);
  expect(result.models.every((model) => !model.facts.fieldEvidence.official_version)).toBe(true);
});

it("强制同步更新版本，版本来源失败时不沿用上次版本冒充当前值", async () => {
  let document = html;
  const fetch = fetcher(async () => doc(document));
  const initial = await discover(fetch, { cacheKey: "account" });
  document = html.replace("0731", "0910");
  const updated = await discover(fetch, { cacheKey: "account", forceRefresh: true });
  expect(initial.models[0]!.facts.officialVersion).toBe("DeepSeek-V4-Flash-0731");
  expect(updated.models[0]!.facts.officialVersion).toBe("DeepSeek-V4-Flash-0910");
  expect(updated.models.map((model) => model.id)).toEqual(initial.models.map((model) => model.id));
  document = "Unavailable";
  expect((await discover(fetch, { cacheKey: "account", forceRefresh: true })).models[0]!.facts.officialVersion).toBeNull();
});

it("凭证验证失败时不访问补充官网，也不使用官网列表兜底权限", async () => {
  const fetch = vi.fn<DiscoveryFetch>(async () => ({ ok: false, status: 401 }));
  await expect(discover(fetch)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("官网响应头返回后正文卡住也会超时取消，晚到正文不会污染同步结果", async () => {
  const aborted = vi.fn();
  let finishBody: ((text: string) => void) | undefined;
  const fetch = vi.fn<DiscoveryFetch>(async (url, options) => {
    if (url === "https://api.deepseek.com/models") {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: ids[0] }] }) };
    }
    options.signal.addEventListener("abort", aborted);
    return { ...doc(), text: () => new Promise<string>((resolve) => { finishBody = resolve; }) };
  });
  const result = await discover(fetch, { timeoutMs: 20 });
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(result.models[0]!.facts.officialVersion).toBeNull();
  finishBody!(html);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(result.models[0]!.facts.officialVersion).toBeNull();
  expect(result.models[0]!.facts.fieldEvidence.official_version).toBeUndefined();
});
