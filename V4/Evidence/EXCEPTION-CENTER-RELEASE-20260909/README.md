# 异常中心 0070 发布准备

- 应用候选：`eb1ed123ec8e919cad0e78947c9cd9c441dee352`。
- 应用 tree：`bb364298d362c22c7628b7f0d36e160563b0deaf`。
- 来源：用户最新预检输出的应用 `1dc468369c56fb59f3a64d40b6136d102b5a1a41`；该版本迁移头为 `0069_auth_error_evidence`，更新后的预检仍会核对数据库实际迁移集合。
- 目标：`0070_alert_recovery_evidence`；仅新增这一项迁移，不修改旧迁移、依赖或Compose配置。
- 沿用脚本：`deploy/scripts/release-runtime-admin-20260908-mac-mini.sh`。
- 脚本 SHA-256：`8201956604a9b25eeac676997f6440064bcea73a6d440acdfb00694f73635679`。
- 默认只读预检；构建在停服务前完成，停止写入服务后备份并验证备份目录，再执行迁移、启动和健康检查。
- 失败时不自动down、不自动恢复数据库备份。若0070已完成且尚无恢复证据，允许保留新增列并恢复原应用；已有恢复证据、迁移集合未知或检查失败，则保留备份、数据库与发布锁，停止应用等待处理，禁止旧代码破坏新证据。
- 验证：`bash -n deploy/scripts/release-runtime-admin-20260908-mac-mini.sh` 通过；现有 `node scripts/rehearse-runtime-admin-release.mjs` 20个隔离场景通过，原始结果见 `script-rehearsal-0070.json`。这不是实际服务器部署，不重新进行业务代码全面审核。

另见 `integration-summary.json`：12个线上凭证修复生产文件逐字保留，27个直接相关测试文件242项通过，相关页面3项通过，类型检查、构建和改动文件lint通过。没有重新进行全面审核或变异测试。

## Mac mini 操作

先获取工具并预检：

```bash
release_tools="$(mktemp -d /Users/stephen/qianliu-exception-release.XXXXXX)" &&
git clone --single-branch --branch codex/exception-center-faults-20260908 \
  ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git "$release_tools" &&
test "$(shasum -a 256 "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" | awk '{print $1}')" = 8201956604a9b25eeac676997f6440064bcea73a6d440acdfb00694f73635679 &&
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --preflight
```

看到 `PREFLIGHT PASS` 后，同一终端执行（会短暂停止应用并升级数据库）：

```bash
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --deploy
```

保存并回传最终 `COMPLETE` 输出。若为 `STOP` 或失败，保留完整输出，不删除锁或强行跳过检查。原始部署说明和回执不覆盖。
