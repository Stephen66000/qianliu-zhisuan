/**
 * 旧严格写激活 CLI —— 已失败关闭（裁决① / PFA-04、PFA-06）。
 *
 * 背景：本入口原先直接调用 `ProviderFinanceCutoverRepository.activateStrictWrites`，
 * 只做单月守恒检查即可把 `strict_writes_enabled` 置为 true，绕过候选、静默租约、
 * 30 分钟 TTL、事实水位复验与企业级幂等，属于资金账本初始化的旁路。
 *
 * 现状：企业级激活只能通过 Control API 的候选流程
 * （activation-preview → activate）完成；新协调器按“先 legacy 锁、再 v1 锁”的固定
 * 顺序取锁，并要求目标企业处于有效静默租约内。
 * 本 CLI 在候选协调器接线完成前一律失败关闭，禁止任何绕过初始化的激活写入。
 *
 * 退出码：2 —— 表示“入口已停用”，与业务冲突（1）区分，便于运维脚本识别。
 */

const MESSAGE = [
  "provider-finance-activate CLI 已停用：企业级严格资金写激活只能通过候选流程完成。",
  "请使用：GET /provider-finance/activation-state → POST /provider-finance/activation-preview",
  "→ POST /provider-finance/activate（需有效静默租约、未过期候选与企业级幂等键）。",
  "禁止直接调用 activateStrictWrites 绕过候选、静默门禁与事实水位复验。",
].join("\n");

process.stderr.write(`${MESSAGE}\n`);
process.exitCode = 2;
