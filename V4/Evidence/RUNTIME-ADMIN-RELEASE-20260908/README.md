# 运行保障与管理员发布包

本包由用户在 Mac mini 手动执行。当前工作不包含生产部署。

## 发布范围

- 最新已提供部署回执：`feca8603210bcc109346faf03860bfea50d61742`，Tree `82d1a4f1553fc362eecaaf18dfbf4c38348687c6`。
- 回执目录：`/Users/stephen/releases/qianliu-august-overview-feca860-20260907-213527`。
- 起始迁移：`0066_subscription_auto_renewal`。
- 目标迁移：`0068_alert_resource_context`，包含 `0067_admin_cleanup`。
- 应用候选：`0bf4c1c0a17afc3a4a380f92958297efd46026b6`，Tree `468182ad84d860aa73b0b71968bfe0453410c4c2`。
- 脚本中的 candidate/tree 为精确应用版本。发布工具包提交与应用版本分开，脚本只获取其绑定的应用版本。
- 保留最新已部署的订阅自动续记、取消、订阅入口、已登记套餐费和金额展示、图片工具结果兼容等改动。
- 相对 feca860，只新增两份数据库迁移；依赖锁文件、Compose、Caddy 配置不变。

起点来自用户此前提供的 COMPLETE 回执，尚未通过 SSH 实时核验。本次已尝试旧 IP（连接超时）与 mDNS 主机名（无法解析）；用户选择自行在 Mac mini 执行。预检会对实际源码、完整迁移列表、容器归属和健康状态作严格比较；不符即停止。

## Mac mini 操作

在 Mac mini 终端执行以下命令，下载 GitHub 分支并运行只读预检：

```bash
release_tools="$(mktemp -d /Users/stephen/qianliu-runtime-admin.XXXXXX)" &&
git clone --single-branch --branch codex/runtime-admin-integration-20260908 \
  ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git "$release_tools" &&
test "$(shasum -a 256 "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" | awk '{print $1}')" = f53db4afe227532d79a1af561997b9e9f4582d8eb87db0528b70dcbae42eb8e5 &&
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --preflight
```

预检不会停服务、构建、备份或执行迁移。成功输出 `PREFLIGHT PASS`；失败时保留完整输出供核对，不要修改预期版本绕过。

确认预检通过、准备正式升级时，在同一终端运行：

```bash
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --deploy
```

脚本在线构建新镜像，保存旧镜像，再暂停业务服务、执行备份及可读性检查、迁移、启动与健康验证。成功后原子更新发布指针并输出 `COMPLETE` 回执。

## 失败恢复

- 构建失败：保留旧容器并恢复镜像标签。
- 已停服后失败：再次停止并核验全部业务容器，确认数据库为已知迁移链且不存在归档管理员，才恢复旧镜像及服务。
- 已出现归档管理员、迁移历史未知、停服或恢复不能核实：保留数据库、备份和部署锁，停止业务服务，等待人工向前修复。
- 不自动降级迁移，不自动还原数据库备份。数据库附加列或已补齐的异常资源数据可能保留。
- 备份和日志位于 `/Users/stephen/backups/qianliu-zhisuan`、`/Users/stephen/logs/qianliu-zhisuan`；确切路径在执行回执中。

## 部署后验收

核对 COMPLETE 中的应用 Commit、Tree、迁移头，以及 Control API/Gateway/Web/入口 200、Worker healthy。页面验收包括异常筛选与详情、每条异常“是否处理”、自动恢复状态，以及已停用管理员归档后的列表与登录行为。通知人员仍不在本次范围。

## 本地证据

- `script-rehearsal-final.json`：隔离命令演练，不连接真实 Docker 或服务器。
- `pg-rehearsal.log`：真实 PG17 的 0066 备份恢复、0067/0068 升级、管理员历史引用与归档后回退保护。
- `full-test.log`：纳入最新已部署改动后的首轮完整非 Web 测试，保留原始失败记录。
- `repaired-regressions.log`：三个旧字段/金额断言适配及真实备份恢复演练，23/23 PASS。
- `database-final.log`、`web-final-r2.log`：受影响包最终全量复跑。
- `independent-release-review.md`：独立有限发布审查，以其实际结论为准。
- 最终校验摘要见 `verification.json`。

旧 0067 候选锁属于此前集成检查点，不可用作本次 0068 发布依据。现场执行结果、页面业务验收及完整 V1.4 历史质量欠账均不由脚本演练代替。
