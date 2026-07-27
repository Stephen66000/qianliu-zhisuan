#!/usr/bin/env tsx
/**
 * evidence:canary —— W01 canary 框架就位验证脚本。
 *
 * 用一个唯一 canary 字面量跑 scanCanary 框架，证明：
 *   1. MetadataLogger 白名单过滤生效（canary 写入非白名单字段后被过滤）；
 *   2. scanCanary 框架可执行，对内存日志缓冲返回命中数；
 *   3. 真实业务接入后，正文/Secret canary 命中数必须为 0。
 *
 * 本脚本不连真实 PG/Redis（W01 无业务数据）；仅验证框架就位。
 */
import { MetadataLogger } from "../logger.js";
import { scanCanary, createLogSinkFromBuffer } from "../canary.js";

const CANARY = "W01_CANARY_PROBE_SECRET_BODY_20260727";

async function main(): Promise<void> {
  // 内存日志缓冲，捕获 MetadataLogger 输出
  let buf = "";
  const logger = new MetadataLogger((line: string) => {
    buf += line + "\n";
  });

  // 故意尝试把 canary 写进非白名单字段 "body"（不应出现在白名单）
  logger.info("probe", { requestId: "req-canary", body: CANARY });

  // 扫描：canary 不应出现在日志（白名单已过滤 body 字段）
  const result = await scanCanary(CANARY, [
    createLogSinkFromBuffer({ text: () => buf }),
  ]);

  console.log("=== evidence:canary W01 框架验证 ===");
  console.log("canary:", CANARY);
  console.log("hits:", JSON.stringify(result.hits));
  console.log("total:", result.total);
  console.log("passed (total===0):", result.passed);
  console.log("");
  console.log("日志缓冲实际内容（白名单字段）:");
  console.log(buf.trim());

  if (!result.passed) {
    console.error("FAIL: canary 命中数非 0，白名单过滤失效");
    process.exit(1);
  }
  console.log("OK: canary 框架就位，白名单过滤生效");
}

main().catch((err) => {
  console.error("evidence:canary 失败:", err);
  process.exit(1);
});
