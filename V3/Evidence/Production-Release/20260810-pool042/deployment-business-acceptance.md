# POOL-042 生产发布与业务验收证据

- 日期：2026-08-10（Asia/Shanghai）
- GitHub `main`／生产候选：`0dd283e7d9fef97ef4d2af85a60ba240295599aa`
- Mac Mini release：`/Users/stephen/releases/qianliu-zhisuan-pool042-0dd283e-20260810-191440`
- 上一 release：`/Users/stephen/releases/qianliu-zhisuan-pool039043-bdbdc01-20260810-124013`
- 发布脚本 SHA-256：`b2423447f9daed87d89b49cb82ac3f14ea075d18efb42ee7368b30d5c40d4a2b`
- 发布日志：`/Users/stephen/logs/qianliu-zhisuan/deploy-pool042-0dd283e-20260810-191440.log`

## 发布事实

1. 候选先精确合入 GitHub `main`，Mac Mini 使用既有 GitHub SSH 身份核验并拉取同一完整 SHA；
   没有用本地工作树替换生产候选。
2. 首次 HTTPS 拉取因 Mac Mini 无交互会话无法读取 Keychain，在拉取阶段 fail-closed；当时尚未停服务、
   备份或切换镜像。随后改用机器既有 GitHub SSH 身份，未绕过 GitHub 来源。
3. 本次没有迁移；发布前后数据库均为 `0044_operating_bill_model_identity`。
4. 停写后生成并验证备份：
   - 路径：`/Users/stephen/backups/qianliu-zhisuan/pre-pool042-20260810-191440.dump`
   - SHA-256：`2cd3d43b2ba5f689538f4a32f963c08e5b1eb6f70dd74faf5cdfed518a0966f2`
5. Release HEAD 精确为候选 SHA，工作树干净；Control API、Gateway、Web 和局域网健康端点均为 HTTP 200，
   Worker healthy，Control API／Gateway／Worker／Web／Caddy 均运行且 restart count 为 0。

## 生产页面只读业务验收：PASS

使用已登录的生产管理页 `https://ic.qianliuai.com/dashboard` 进行只读验收，没有保存配置或修改业务数据：

- DeepSeek API 行本月总 Token 为 `52,770,880`，计量质量为“精确计量”；输入 `52,481,728`、
  输出 `289,152`、缓存 `50,660,864`、推理 `59,960`。
- Token 速度为 `1,367.5 Token/小时`；余额可承载 Token 为约 `129,373,191`，明确标记
  `估算 · LOW`，依据为最近 24 小时账本、账号与当前价格分布。
- 模型下钻真实可展开，包含 `ql-deepseek-v4-flash`（`1,726,771` Token）与
  `ql-deepseek-v4-pro`（`135` Token）；历史笼统 alias 的既有账本仍按历史事实显示，不改写账本。
- 页面同时保留余额 `CNY 68.00`、本期费用 `47.41` 与本月费用 `6.34`，未混淆各自时间窗口。

## 结论

POOL-042 双审、GitHub 主线集成、Mac Mini 发布、服务健康和生产页面业务验收全部通过，问题关闭。
