/**
 * `formatModelName` 官方展示名规则表驱动测试。
 *
 * 该函数是 worker 与 control-api 曾经分叉过的历史逻辑的唯一权威实现，
 * 之前**无任何单测**（domain 覆盖率 ratchet 长期被它拖低）。这里逐条钉住每条规则，
 * 并刻意覆盖 `||` 的右操作数（如 `deepseek-chat`、`moonshot`、`claude-3.5-sonnet`）
 * 与「未命中规则原样返回」的兜底路径。
 */
import { describe, expect, it } from "vitest";

import { formatModelName } from "../model-display-name.js";

describe("网关别名前缀剥离", () => {
  it("剥离新制 ql- 前缀", () => {
    expect(formatModelName("ql-deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(formatModelName("  QL-GLM-5.3  ")).toBe("GLM 5.3");
  });

  it("剥离旧制 qianliu- 前缀及冗余厂商前缀", () => {
    expect(formatModelName("qianliu-zhipu-glm-5.2")).toBe("GLM 5.2");
    expect(formatModelName("qianliu-moonshot-kimi-k3")).toBe("K3");
    expect(formatModelName("qianliu-deepseek-deepseek-v3")).toBe("DeepSeek V3");
    expect(formatModelName("qianliu-qwen-qwen-max")).toBe("Qwen Max");
    expect(formatModelName("qianliu-openai-gpt-4o")).toBe("GPT-4o");
    expect(formatModelName("qianliu-anthropic-claude-3-5-sonnet")).toBe("Claude 3.5 Sonnet");
  });

  it("剥离中文厂商前缀", () => {
    expect(formatModelName("智谱 GLM-5.3")).toBe("GLM 5.3");
    expect(formatModelName("月之暗面 Kimi K3")).toBe("K3");
  });
});

describe("版本号写法归一", () => {
  it("glm 的横杠/空格写法统一为点号", () => {
    expect(formatModelName("glm-5-2")).toBe("GLM 5.2");
    expect(formatModelName("glm 5.2")).toBe("GLM 5.2");
    expect(formatModelName("GLM-5.2")).toBe("GLM 5.2");
    expect(formatModelName("glm-4-6")).toBe("GLM 4.6");
  });
});

describe("DeepSeek 精确版本优先", () => {
  it("先长后短匹配，避免串代", () => {
    expect(formatModelName("deepseek-v4-flash-vision-exp")).toBe("DeepSeek V4 Flash Vision Exp");
    expect(formatModelName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(formatModelName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(formatModelName("deepseek-v3")).toBe("DeepSeek V3");
    expect(formatModelName("deepseek-chat")).toBe("DeepSeek V3");
    expect(formatModelName("deepseek-r1")).toBe("DeepSeek R1");
    expect(formatModelName("deepseek-reasoner")).toBe("DeepSeek R1");
    expect(formatModelName("deepseek")).toBe("DeepSeek");
  });
});

describe("智谱 GLM 精确版本优先", () => {
  it("5.x / 4.x 逐档匹配，最后泛型兜底", () => {
    expect(formatModelName("glm-5.3")).toBe("GLM 5.3");
    expect(formatModelName("glm-5.2")).toBe("GLM 5.2");
    expect(formatModelName("glm-5")).toBe("GLM 5");
    expect(formatModelName("glm 5")).toBe("GLM 5");
    expect(formatModelName("glm-4.7")).toBe("GLM 4.7");
    expect(formatModelName("glm-4.6")).toBe("GLM 4.6");
    expect(formatModelName("glm-4.5")).toBe("GLM 4.5");
    expect(formatModelName("glm-4-plus")).toBe("GLM-4");
    expect(formatModelName("glm 4")).toBe("GLM-4");
    expect(formatModelName("glm")).toBe("GLM");
  });

  it("glm-5.2 不得被错标为 GLM 5（泛型规则的负向边界）", () => {
    expect(formatModelName("glm-5.2")).not.toBe("GLM 5");
  });
});

describe("Kimi / K3 档位优先", () => {
  it("k3 档位与厂商名分别处理", () => {
    expect(formatModelName("k3-256k")).toBe("K3 256K");
    expect(formatModelName("k3 256k")).toBe("K3 256K");
    expect(formatModelName("kimi-for-coding-highspeed")).toBe("Kimi For Coding Highspeed");
    expect(formatModelName("kimi-for-coding")).toBe("Kimi For Coding");
    expect(formatModelName("k3")).toBe("K3");
    expect(formatModelName("kimi-k2")).toBe("Kimi Chat");
    expect(formatModelName("moonshot-v1")).toBe("Kimi Chat");
  });
});

describe("Claude / GPT / Qwen / 嵌入模型", () => {
  it("按厂商规则归一", () => {
    expect(formatModelName("claude-3-5-sonnet")).toBe("Claude 3.5 Sonnet");
    expect(formatModelName("claude-3.5-sonnet")).toBe("Claude 3.5 Sonnet");
    expect(formatModelName("claude-3-7-sonnet")).toBe("Claude 3.7 Sonnet");
    expect(formatModelName("claude-3.7-sonnet")).toBe("Claude 3.7 Sonnet");
    expect(formatModelName("gpt-4o-mini")).toBe("GPT-4o mini");
    expect(formatModelName("gpt-4o")).toBe("GPT-4o");
    expect(formatModelName("qwen-max")).toBe("Qwen Max");
    expect(formatModelName("qwen-plus")).toBe("Qwen Plus");
    expect(formatModelName("text-embedding-3-large")).toBe("Embedding 3");
  });
});

describe("未命中规则时原样返回", () => {
  it("已是规范展示名或未知型号时不做猜测", () => {
    expect(formatModelName("Acme Turbo 9000")).toBe("Acme Turbo 9000");
    expect(formatModelName("  My Internal Model  ")).toBe("My Internal Model");
    expect(formatModelName("")).toBe("");
  });

  it("已是 K3 档位名时不重复加工（k3 规则优先于厂商名）", () => {
    expect(formatModelName("Kimi K3")).toBe("K3");
  });
});
