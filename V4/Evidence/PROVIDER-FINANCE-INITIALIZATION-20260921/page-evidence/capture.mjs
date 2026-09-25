/**
 * WP05 页面证据截图器（仅本地取证，不是产品代码）。
 *
 * 用系统 Chrome 的 headless 模式 + DevTools Protocol 打开 `apps/web/dist` 的真实构建产物，
 * 通过切换 `scenario.json` 与脚本化点击，逐个捕获 WP05 的关键界面状态。
 * 不依赖 playwright / puppeteer（本机未安装浏览器二进制），仅用 Node 内置 `WebSocket`。
 *
 * 用法：node capture.mjs <distDir> <outDir> <serverPort> <chromeDebugPort>
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { connectWebSocket } from "./ws-client.mjs";

const [DIST, OUT, SERVER_PORT = "4180", DEBUG_PORT = "9333"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const SCENARIO_FILE = join(import.meta.dirname, "scenario.json");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_TITLE = "厂商资源 · 仟流智算";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let messageId = 0;
const pending = new Map();

function send(socket, method, params = {}) {
  const id = ++messageId;
  socket.sendText(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
  });
}

async function evaluate(socket, expression) {
  const result = await send(socket, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function waitFor(socket, selector, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(socket, `!!document.querySelector(${JSON.stringify(selector)})`)) return;
    if (Date.now() > deadline) {
      const text = await evaluate(socket, "document.body.innerText.slice(0, 600)");
      throw new Error(`等待 ${label}（${selector}）超时。当前页面文本：\n${text}`);
    }
    await sleep(150);
  }
}

async function clickByText(socket, text) {
  const result = await evaluate(socket, `(() => {
    const target = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll("button")].find((node) => node.textContent.trim().includes(target));
    if (!el) return "not-found";
    el.click();
    return "clicked";
  })()`);
  if (result !== "clicked") throw new Error(`未找到按钮：${text}`);
  await sleep(400);
}

async function setScenario(patch) {
  await writeFile(SCENARIO_FILE, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
}

async function capture(socket, outDir, filename, height = 1500) {
  await send(socket, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(500);
  const shot = await send(socket, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = join(outDir, filename);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  console.log(`  ✓ ${filename}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new",
    // 本机沙箱不可用（`sandbox initialization failed: Operation not permitted`），
    // 不加 --no-sandbox 时渲染/网络进程会反复崩溃，DevTools 端口虽在但收不到任何响应帧。
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=/tmp/wb-wp05-chrome-profile`, "about:blank",
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
        target = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? null;
      } catch { /* 端口尚未就绪 */ }
    }
    if (target === null) throw new Error("无法连接到 Chrome 调试端口");

    const socket = connectWebSocket(target.webSocketDebuggerUrl);
    socket.onText((text) => {
      const message = JSON.parse(text);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await socket.ready;

    await send(socket, "Page.enable");
    await send(socket, "Runtime.enable");

    const goto = async (path) => {
      await send(socket, "Page.navigate", { url: `${BASE}${path}` });
      await waitFor(socket, ".ql-sidebar, aside, main", "应用外壳");
      await sleep(800);
    };

    console.log("捕获 1/5：未激活 → 初始化向导");
    await setScenario({ state: "unactivated", preview: "none" });
    await goto("/resources?tab=finance");
    await waitFor(socket, '[data-testid="activation-wizard"]', "初始化向导");
    await waitFor(socket, '[data-testid="activation-draft-editor"]', "草稿编辑器");
    console.log(`  页面标题：${await evaluate(socket, "document.title")}`);
    await capture(socket, OUT, "01-未激活-初始化向导与静默排空.png");

    console.log("捕获 2/5：预检 GO_CANDIDATE → 可激活");
    await setScenario({ state: "go", preview: "go" });
    await send(socket, "Page.reload");
    await waitFor(socket, '[data-testid="activation-wizard"]', "初始化向导");
    await clickByText(socket, "执行预检");
    await waitFor(socket, '[data-testid="activation-preview-result"]', "预检结果");
    await capture(socket, OUT, "02-预检GO_CANDIDATE-候选与缺口.png");

    console.log("捕获 3/5：不可逆激活二次确认");
    await clickByText(socket, "进入不可逆激活确认");
    await waitFor(socket, '[data-testid="activation-confirm"]', "二次确认弹窗");
    await capture(socket, OUT, "03-不可逆激活二次确认-企业复核.png");

    console.log("捕获 4/5：预检 NO_GO → 结构化缺口");
    await setScenario({ state: "no_go", preview: "no_go" });
    await send(socket, "Page.reload");
    await waitFor(socket, '[data-testid="activation-wizard"]', "初始化向导");
    await clickByText(socket, "执行预检");
    await waitFor(socket, '[data-testid="activation-gaps"]', "结构化缺口");
    await capture(socket, OUT, "04-预检NO_GO-结构化缺口.png");

    console.log("捕获 5/5：已激活 → 日常面板 + 不可变回执");
    await setScenario({ state: "activated", preview: "none" });
    await send(socket, "Page.reload");
    await waitFor(socket, '[data-testid="activation-receipt"]', "激活回执");
    await capture(socket, OUT, "05-已激活-日常资金面板与不可变回执.png");

    console.log(`页面标题常量：${PAGE_TITLE}`);
    socket.close();
  } finally {
    chrome.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(`证据截图失败：${error.message}`);
  process.exitCode = 1;
});
