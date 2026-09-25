# WP05 页面证据（page evidence）

本目录存放 WP05（任务 5.1～5.5）Web 界面的**页面证据截图**，以及生成这些截图的可复现脚本。

## 截图清单

| 文件 | 覆盖任务 | 说明 |
| --- | --- | --- |
| `01-未激活-初始化向导与静默排空.png` | 5.1、5.2、5.3 | `strict_writes_enabled=false` 时资金标签页切换为初始化向导：五类草稿区、静默与排空面板（含两段式门禁与「仍未排空」提示）、结构化预检入口 |
| `02-预检GO_CANDIDATE-候选与缺口.png` | 5.3 | 预检返回 GO_CANDIDATE：候选 ID/哈希、事实水位、TTL 剩余秒数、UNKNOWN_COST 缺口定位（含「不能用旧记录关闭绕过」提示）、「进入不可逆激活确认」入口 |
| `03-不可逆激活二次确认-企业复核.png` | 5.4 | 不可逆激活确认：企业、候选 ID/哈希、事实水位、到期时间与剩余秒数、影响范围、确定性用量修复、影响资源账户，以及「再次输入目标企业 ID」逐字复核（未输入时提交按钮禁用） |
| `04-预检NO_GO-结构化缺口.png` | 5.3 | 预检返回 NO_GO：缺口按类别分组（期初 / 充值 / 购买 / 旧记录 / 用量），每条给到资源、币种、月份、旧记录或用量行定位；激活入口禁用 |
| `05-已激活-日常资金面板与不可变回执.png` | 5.1、5.5 | `strict_writes_enabled=true` 时切换回日常资金面板，上方常驻不可变激活回执（候选、哈希、水位、覆盖月份、守恒通过、六类写入事实计数） |

## 复现方式

```bash
# 1. 构建前端产物（仓库根目录）
corepack pnpm@11.11.0 --filter @qianliu/web run build

# 2. 启动静态托管 + 桩 API（只服务本地 dist，不连接任何真实服务）
node mock-server.mjs <仓库>/apps/web/dist 4181

# 3. 用本机 Chrome headless + DevTools Protocol 截图
node capture.mjs <仓库>/apps/web/dist "$PWD" 4181 9352
```

## 取证边界（重要）

- **这不是端到端测试**：`/api/*` 全部由 `mock-server.mjs` 提供桩数据，用于让真实构建产物
  渲染出指定界面状态；资金写入、预检投影、静默租约等**服务端行为由 WP04 的
  control-api 集成测试保证**，本目录不重复验证。
- 截图里的哈希、水位、金额、企业 ID 均为桩数据，**不对应任何真实企业或资金事实**。
- Chrome 需加 `--no-sandbox --disable-dev-shm-usage`：本机沙箱不可用
  （`sandbox initialization failed: Operation not permitted`），不加时渲染进程反复崩溃、
  DevTools 端口虽在但收不到任何响应帧。
- 脚本仅依赖 Node 内置模块与系统 Chrome；不安装 playwright / puppeteer。
  `ws-client.mjs` 是手写的最小 WebSocket 客户端（文本帧 + 掩码 + 扩展长度），
  因为 Node 22 内置 `WebSocket` 在本机 Chrome DevTools 端点上握手成功但收不到消息帧。
