/**
 * 大模型官方标准展示名称规则（领域层唯一权威实现）。
 *
 * 历史背景：该函数曾散弹枪式复制于 apps/worker 与 apps/control-api 两处并已分叉
 * （DeepSeek-V3 vs DeepSeek V3）。2026-09-14 I1 审核整改提取至 domain，
 * 以 worker 侧 2026-09-14 修订版为准，control-api 侧行为随之统一。
 */

/**
 * 格式化大模型名称为官方标准展示名称。
 *
 * 匹配策略（2026-09-14 修订）：
 * 1. 先剥离网关别名前缀：`ql-` 新制、`qianliu-{vendor}-` 旧制、中文厂商前缀（智谱/月之暗面）；
 * 2. 版本号写法归一：`glm-5-2` / `glm 5.2` → `glm-5.2`；
 * 3. 精确版本优先（glm-5.3 先于 glm-5，v4-flash-vision-exp 先于 v4-flash），
 *    杜绝 `includes("glm-5")` 把 5.2 错标成 5.3 这类串代问题；
 * 4. 未命中规则时原样返回（display_name 已是规范展示名时直接放行）。
 */
// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：厂商型号精确匹配链，后续改为表驱动匹配。
export function formatModelName(rawName: string): string {
  let clean = rawName.trim();

  // 1. 剥离网关别名前缀（新制 ql- 与旧制 qianliu-{vendor}-）
  if (clean.toLowerCase().startsWith("ql-")) {
    clean = clean.slice(3).trim();
  } else if (clean.toLowerCase().startsWith("qianliu-")) {
    clean = clean.replace(/^qianliu-/i, "").trim();
    // 剥离历史可能存在的冗余厂商前缀（如 zhipu-glm / moonshot-kimi / deepseek-deepseek）
    clean = clean
      .replace(/^(zhipu|moonshot|openai|anthropic)-/i, "")
      .replace(/^deepseek-deepseek-/i, "deepseek-")
      .replace(/^qwen-qwen-/i, "qwen-")
      .trim();
  }
  // 剥离中文厂商前缀（如「智谱 GLM-5.3」「月之暗面 Kimi K3」）
  clean = clean.replace(/^(智谱|月之暗面)\s*/, "").trim();

  // 2. 版本号归一：glm-5-2 / glm 5 2 / GLM-5.2 → glm-5.2
  const lower = clean.toLowerCase().replace(/glm[- ](\d)[- .](\d)/g, "glm-$1.$2");

  // 3. 精确版本优先匹配
  // DeepSeek
  if (lower.includes("deepseek-v4-flash-vision-exp")) return "DeepSeek V4 Flash Vision Exp";
  if (lower.includes("deepseek-v4-flash")) return "DeepSeek V4 Flash";
  if (lower.includes("deepseek-v4-pro")) return "DeepSeek V4 Pro";
  if (lower.includes("deepseek-v3") || lower === "deepseek-chat") return "DeepSeek V3";
  if (lower.includes("deepseek-r1") || lower.includes("deepseek-reasoner")) return "DeepSeek R1";
  if (lower === "deepseek") return "DeepSeek";

  // 智谱 GLM（先 5.x 精确版本，再 4.x 精确版本，最后泛型兜底）
  if (lower.includes("glm-5.3")) return "GLM 5.3";
  if (lower.includes("glm-5.2")) return "GLM 5.2";
  if (/glm[- ]5(?![.\d])/.test(lower)) return "GLM 5";
  if (lower.includes("glm-4.7")) return "GLM 4.7";
  if (lower.includes("glm-4.6")) return "GLM 4.6";
  if (lower.includes("glm-4.5")) return "GLM 4.5";
  if (lower.includes("glm-4") || lower.includes("glm 4")) return "GLM-4";
  if (lower === "glm") return "GLM";

  // Kimi / K3（k3 语义优先于 kimi 厂商名，256K 档位保留）
  if (lower.includes("k3-256k") || lower.includes("k3 256k")) return "K3 256K";
  if (lower.includes("kimi-for-coding-highspeed")) return "Kimi For Coding Highspeed";
  if (lower.includes("kimi-for-coding")) return "Kimi For Coding";
  if (lower.includes("k3")) return "K3";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "Kimi Chat";

  // Claude / GPT / Qwen
  if (lower.includes("claude-3-5-sonnet") || lower.includes("claude-3.5-sonnet")) return "Claude 3.5 Sonnet";
  if (lower.includes("claude-3-7-sonnet") || lower.includes("claude-3.7-sonnet")) return "Claude 3.7 Sonnet";
  if (lower.includes("gpt-4o-mini")) return "GPT-4o mini";
  if (lower.includes("gpt-4o")) return "GPT-4o";
  if (lower.includes("qwen-max")) return "Qwen Max";
  if (lower.includes("qwen-plus")) return "Qwen Plus";

  // 嵌入模型
  if (lower.includes("embedding-3")) return "Embedding 3";

  return clean;
}
