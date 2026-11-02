# 安全依赖与局部 Node 重验

用户已明确追加授权最小依赖安全更新与项目局部 Node 22.x 重验。生产、系统默认 Node、历史账本均未改变。

当前第三候选：Node **22.23.4**，Darwin arm64 的 ICU78.3/tz2026e；项目局部目录 `.local-runtime/node-v22.23.4-darwin-arm64/bin`。官方包已与固定版本 SHASUMS256 校验；CI、Dockerfile、engines、.node-version 和工程 runtime 合同已同步。Linux 镜像实际运行与字体渲染尚需本轮重验。

当前锁文件 SHA-256：`3bebc5d88ca86fdfad321e6c74bb144718b1c86a97d4ec82552ea6961e35ef90`。

本机复现须从仓库根目录按进程选择新运行时，例如：

```sh
PATH="$PWD/.local-runtime/node-v22.23.4-darwin-arm64/bin:$PATH" corepack pnpm@11.11.0 run test
```

未加该前缀的系统 `node --version` 仍为 v22.17.1；项目显式二进制为 v22.23.4。新 engines 会拒绝旧版本，不能绕过 engines 检查。其他机器按 `.node-version` 安装匹配版本，局部二进制不随 Git 或 Docker context 分发。

## 实际审计

- 原始生产依赖审计：67 条（24 high、31 moderate、12 low）。
- 第一候选：原审计配置下 0 条，但真实 glob7 兼容测试失败，不能交付。
- 第二、第三候选：**移除全部 auditIgnore 后实际生产依赖审计均为 0 条，所有严重级别均为 0，退出码 0**。见 audit-after-second-no-ignore.json、audit-after-third-no-ignore.json；安全清零不替代兼容验收。
- 原唯一例外 GHSA-qwww-vcr4-c8h2 已过期；[上游公告](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)现列修复为 7.18.2，项目本来已经安装该版本。故移除无效旧例外及 ignore，不新增任何风险接受。旧条目保存在 removed-security-exception.json。

审计结论限当前依赖图及生产依赖范围，不代表所有开发依赖、未知漏洞或线上可利用性结论。

## 实际版本与兼容边界

直接依赖：Fastify5.12.6、Undici7.30.1、Zod4.6.6。传递版本按原主版本分别修补 Undici8.12.2、fast-uri3.1.9/4.2.3、brace-expansion1.1.21/2.1.7、grpc-js1.14.5、busboy3.2.2。

第一候选 scoped glob7→minimatch11 仍因 glob7 使用私有 Regex._glob 报 TypeError，普通 `**/*.txt` 已真实复现。失败证据在 ../security-refresh/，不降低断言、不补第三方私有字段。

第二候选曾限定 ExcelJS→archiver7，但实际 WorkbookWriter 遇到 StreamBuf.pipe() 不返回 destination，被 archiver-utils5 转成 undefined，真实流写测试失败。失败保留，不能只凭静态接口匹配接受此候选。

第三候选保留 ExcelJS4.4 与原 archiver5，只限定 archiver-utils2/3/5→glob14.0.2 和 readdir-glob1→minimatch11.0.1；unzipper0.12.5 移除旧 fstream/rimraf/glob7 生产链。没有全局替换 minimatch、glob 或 archiver；开发期旧可调用 API 保持原合同。实际 glob/归档/模板、Excel buffer/load/file 以及独立 stream writer 已通过。

额外 WorkbookReader 探针仍失败：合法 ZIP 在新版 Parse 的暂停/end 时序下提前停止，模型元数据缺失；调整 chunk 或重排 ZIP 只能让部分样例通过，不能当通用修复。项目唯一生产 Excel 入口 `apps/control-api/src/directory/excel.ts` 仅使用 writeBuffer/load，没有 WorkbookReader/Writer。用户已同意按原实际业务收口并要求不要过度开发，因此此额外接口继续保持 FAIL/UNCERTIFIED 记录，不作为本次实际业务交付阻断，不维护第三方补丁，也不对外承诺整个 ExcelJS 接口兼容。见 ../security-refresh/ 的原始结果与 reader 诊断。

## 证据有效性

每轮安装前所有旧 runner 均自然结束。第一、第二候选通过的静态/CLI结果保留为相应候选事实，不能挪到新锁文件下。第三候选 typecheck/lint/build、架构、大小、重复、许可证与日志 canary 框架均退出码0，见 third-candidate/；PG/Redis/Trace 没有在 canary 框架命令中扫描，不能填零冒充完整零留存验证。最终交付仍需绑定本轮锁文件与最终源码的全包/覆盖/变异/浏览器/容器证据。

月界等价证明也不能沿用旧 Node22.17.1/ICU77.1/tz2025b 绑定。新本地证明和实际 Linux 候选运行时核实后再登记，绑定失效期间门禁保持失败。
