# 0912这个后端worker hand off

> **交接日期**：2026-09-12  
> **文档主题**：仟流智算企业微信长图报表、激励卡片与后端 Worker 自动化推送引擎交接指南  
> **交接目标**：帮助接手同事快速掌握上下文，无缝推进 `apps/worker` 生产级报表与激励推送引擎的代码落地、调度集成与企微真机验收。

---

## 🧭 一、 项目背景与核心业务目标

本项目旨在为“仟流智算”打造一套**极简专业、数据权威、激励人心**的企业微信长图报表与主动交互服务体系。

### 1.1 四大约束与设计法则（必须严格遵守）
1. **Token “万/亿”统一进位计量法则（最高优先级强制规范）**：
   - **全盘彻底杜绝**千分位长纯数字（如 `328,500`、`1,280,000`）；
   - 所有 Token 消耗量一律保留 **1 位小数，四舍五入**；
   - **$< 1$ 亿（100,000,000）**：以 **“万”** 为单位（如 `32.9 万`、`128.0 万`、日均 `4.7 万 /天`）；
   - **$\ge 1$ 亿**：升格为 **“亿”** 为单位（如 `1.3 亿`、`2.5 亿`）；
   - 请求次数保留“次”（如 `75 次`、`1,620 次`）。
2. **纯粹智算指标原则**：
   - 卡片上只展示智算平台本身的权威数据（消耗量、请求次数、主力模型分布、团队排位），**严禁出现**企微协同天数、出勤考勤等非智算平台指标。
3. **极简白卡信笺排版**：
   - 统一画布尺寸 **540 × 800 px**（卡片 460 × 700 px）；
   - X 轴双基准律动（主基准线 `X = 94`，缩进标点外挂线 `X = 118`，右锚定线 `X = 445`）；
   - Y 轴绝对等距居中（顶部留白与底部留白严格 **`71px : 71px`**）。
4. **Emoji 避坑原则**：
   - 由于 `@resvg/resvg-js` 服务端渲染环境缺失彩色 Emoji 字体，若在 SVG 中直接写 `🥇`、`🚀` 会被渲染为乱码或方框（`????`）。卡片中所有徽章、奖牌一律采用矢量图形（如 `<circle>`、圆角矩形）绘制。

---

## 📦 二、 前序已完成的工作与定稿资产清单

前序阶段已完成全场景的视觉定稿、格式规范归档、主动交互问答实现与单元测试覆盖。接手同事可直接复用现有资产：

### 2.1 四套定稿长图规范与原型脚本
| 场景 | 核心设计规范文档 | 原型脚本（可直接复制 SVG 模板） | 渲染成品图片 |
| :--- | :--- | :--- | :--- |
| **场景一：员工个人周报小结** | [`文档/仟流智算-个人周报小结视觉与格式规范-v1.0.md`](file:///Users/mac/Projects/仟流智算/文档/仟流智算-个人周报小结视觉与格式规范-v1.0.md) | `scratch/generate_final_aligned.cjs` | `personal_weekly_final_aligned.png` |
| **场景二：团队全员用量周报** | [`文档/仟流智算-团队全员用量周报视觉与格式规范-v1.0.md`](file:///Users/mac/Projects/仟流智算/文档/仟流智算-团队全员用量周报视觉与格式规范-v1.0.md) | `scratch/generate_option1_final.cjs` | `company_weekly_report_v1.png` |
| **场景三(a)：登顶第 1 名荣誉卡** | [`文档/仟流智算-激励卡片-登顶第一名视觉与触发规范-v1.0.md`](file:///Users/mac/Projects/仟流智算/文档/仟流智算-激励卡片-登顶第一名视觉与触发规范-v1.0.md) | `scratch/generate_top1_refined.cjs` | `incentive_top1_v1.png` |
| **场景三(b)：超越 50% 员工成长卡** | [`文档/仟流智算-激励卡片-超越50%员工视觉与触发规范-v1.0.md`](file:///Users/mac/Projects/仟流智算/文档/仟流智算-激励卡片-超越50%员工视觉与触发规范-v1.0.md) | `scratch/generate_over50_user_spec.cjs` | `incentive_over50_v1.png` |

### 2.2 场景四：企业微信智能查用量（Chatbot 问答）
- **规范文档**：[`文档/仟流智算-企业微信智能查用量交互与回调规范-v1.0.md`](file:///Users/mac/Projects/仟流智算/文档/仟流智算-企业微信智能查用量交互与回调规范-v1.0.md)
- **代码实现**：
  - `apps/control-api/src/wecom/intent-parser.ts`：自然语言解析（今天、昨天、本周、上周、本月、全员/个人）；
  - `apps/control-api/src/wecom/message-handler.ts`：用量聚合查询、主力模型 Top 3 提取、排位激励小贴士、越权降级提示；
  - `apps/control-api/src/wecom/callback-routes.ts`：企微加解密与 5 秒被动回复；
- **测试覆盖**：`src/wecom/__tests__/` 下 26 个单元测试全部通过。

### 2.3 演示原型
- [`preview.html`](file:///Users/mac/.gemini/antigravity/brain/ca325754-d9a5-4709-b847-39bfc107076b/preview.html)：集成了 4 个 Tab 的浏览器端交互演示，供随时对比验收视觉效果。

---

## 🛠 三、 接手同事的当前任务：Worker 生产级报表引擎落地

当前 `apps/worker/src/reporting/daily-token-report.ts` 仍是早期的 800px 深色科技风实验原型，需要将其重构升级为支持全场景的**生产级报表自动化引擎**。

### 3.1 建议的项目工程结构
建议在 `apps/worker/src/reporting/` 下进行模块化组织：

```text
apps/worker/src/reporting/
├── assets/
│   └── qianliu-logo-cropped.png       # 官方 Logo 切图（从 scratch/qianliu-logo-cropped.png 复制）
├── format-utils.ts                    # 共享函数：formatTokenVolume, formatPercentage, formatModelName, escapeXml
├── render-png.ts                      # Resvg 渲染封装（入参 svg 字符串，输出 Buffer）
├── templates/                         # 4 套 540x800 SVG 模版（直接继承 scratch/ 下的成熟脚本逻辑）
│   ├── personal-weekly-svg.ts         # 场景一：个人周报信笺白卡
│   ├── company-weekly-svg.ts          # 场景二：团队全员用量看板
│   ├── incentive-top1-svg.ts          # 场景三(a)：登顶第 1 名流动红旗
│   └── incentive-over50-svg.ts        # 场景三(b)：月度超越 50% 员工成长卡
├── report-jobs.ts                     # 周报业务逻辑：全员周报与员工个人周报生成与推送
├── incentive-jobs.ts                  # 激励业务逻辑：周三至周日登顶检测与月度超越检测
└── index.ts                           # 统一导出
```

---

## 📝 四、 关键核心代码实现指引

### 4.1 统一计量工具 `format-utils.ts`
可以直接复用 `apps/control-api/src/wecom/message-handler.ts` 中的已验证实现：
```typescript
export function formatTokenVolume(
  tokens: number | string | bigint,
  options?: { isDailyAvg?: boolean; showTokensWord?: boolean },
): string {
  const n = typeof tokens === "bigint" ? Number(tokens) : typeof tokens === "string" ? Number(tokens) : tokens;
  const isDaily = options?.isDailyAvg ?? false;
  const suffix = options?.showTokensWord ? " Tokens" : "";

  if (!Number.isFinite(n) || n <= 0) {
    const unit = isDaily ? "万 /天" : "万";
    return `0.0 ${unit}${suffix}`;
  }
  if (n >= 100_000_000) {
    const val = (n / 100_000_000).toFixed(1);
    const unit = isDaily ? "亿 /天" : "亿";
    return `${val} ${unit}${suffix}`;
  }
  const val = (n / 10_000).toFixed(1);
  const unit = isDaily ? "万 /天" : "万";
  return `${val} ${unit}${suffix}`;
}

export function formatPercentage(share: string | number): string {
  if (typeof share === "string" && share.includes("%")) return share;
  const num = typeof share === "string" ? parseFloat(share) : share;
  if (!Number.isFinite(num) || num <= 0) return "0.0%";
  return `${(num * 100).toFixed(1)}%`;
}

export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
```

### 4.2 高清图片渲染管道 `render-png.ts`
```typescript
import { Resvg } from "@resvg/resvg-js";

export function renderSvgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 540 },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "-apple-system",
    },
  });
  const pngData = resvg.render();
  return pngData.asPng();
}
```

### 4.3 企微下发通道 `WecomAppClient`（已有现成实现）
位于 `apps/worker/src/runtime-assurance/wecom-client.ts`：
1. `client.uploadMedia(endpoint, pngBuffer, filename)`：上传图片到企微临时素材库，获取 `media_id`；
2. `client.sendImageMessage(endpoint, toUsers, mediaId)`：发送图片消息；
3. `client.sendTextMessage(endpoint, toUsers, text)`：发送附带的文本摘要。

---

## ⏰ 五、 业务触发与定时调度逻辑

### 5.1 周报推送业务（每周一早 09:00）
- **时间范围计算**：
  - 统计周期固定为**上一自然周**（上周一 00:00:00 至上周日 23:59:59）。
- **执行流程**：
  1. 调用 `UsageOverviewRepository.getOverview({ period: "WEEK", anchor: lastWeekAnchor })` 获取全员数据；
  2. 生成全员周报 540×800 图片，推送至企业管理员或企微管理群；
  3. 遍历 `overview.ranking` 中上周有调用的员工列表；
  4. 为每位员工单独生成个人周报白卡（含该员工的姓名、总请求、周消耗、日均、最晚时间、金句）；
  5. 依据 `person_external_identity` 将个人图片单聊推送给员工本人。

### 5.2 登顶第一名流动红旗（周三至周日每日上午 09:30）
- **规则**：
  - 周一、周二因样本天数较少默认不开放；
  - 每天限发 1 张红旗卡；
  - 必须满足“易主夺旗”（当前榜首与昨日榜首不同）；
  - 每位员工每周限领 1 次（防止频繁刷屏）；
  - 下周一结算以周报为准。
- **持久化记录建议**：在缓存或数据库表记录当周红旗发放历史 `(enterprise_id, week, winner_person_id, awarded_date)`。

### 5.3 月度超越 50% 成长卡（每月 15 日及月末）
- **规则**：
  - 当月累计消耗跨过团队中位数线；
  - 每人每月限领 1 次；
  - 重点鼓励从“轻度使用者”跃升为“中度/主力使用者”的普惠激励。

---

## 💻 六、 CLI 指令与调度器接入（`apps/worker/src/main.ts`）

### 6.1 需增加的 CLI 调试命令
```bash
# 1. 团队全员周报测试（支持 --dry-run 仅生成不发送）
worker report-company-weekly --enterprise <id> [--week <YYYY-Www>] [--dry-run]

# 2. 员工个人周报批量或单人测试
worker report-personal-weekly --enterprise <id> [--user <person-id>] [--dry-run]

# 3. 激励巡检测试
worker check-incentives --enterprise <id> [--dry-run]
```

---

## 🧪 七、 避坑指南与环境测试命令

### 7.1 必须使用 `corepack pnpm`
当前环境未配置全局独立 pnpm，所有命令请带 `corepack`：
```bash
# 运行 control-api 的企微测试
corepack pnpm --filter @qianliu/control-api exec vitest run --config ../../vitest.config.ts src/wecom/__tests__/

# 运行 worker 的单元测试
corepack pnpm --filter @qianliu/worker exec vitest run --config ../../vitest.config.ts src/reporting/__tests__/

# TypeScript 类型检查
corepack pnpm --filter @qianliu/worker exec tsc -p tsconfig.json --noEmit
```

> [!CAUTION]
> **绝对不要执行全量 `pnpm test`**：项目内部分集成测试会尝试启动 Docker testcontainers 容器，在无本地 Docker 守护进程的环境下会导致整体报错退出。只跑具体的单元测试文件即可！

---

## 🏁 八、 验收标准与交付检查表 (Checklist)

接手同事完成开发后，可通过以下清单快速验收：
- [ ] 1. 生成的所有图片尺寸均严格为 **540 × 800 px**，无模糊与贴边变形；
- [ ] 2. 图片中所有 Token 均符合“万 / 亿保留 1 位小数四舍五入”，无任何未转换的千分位长数字；
- [ ] 3. Resvg 渲染出的 PNG 无任何文字乱码或方框问号（无彩色 Emoji 依赖）；
- [ ] 4. 运行 `corepack pnpm --filter @qianliu/worker exec tsc -p tsconfig.json --noEmit` 0 报错；
- [ ] 5. CLI 命令 `--dry-run` 能够稳定输出报告数据并在本地保存预览图片。
