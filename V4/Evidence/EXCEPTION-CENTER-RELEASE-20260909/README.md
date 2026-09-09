# 异常中心 0069 发布准备

- 应用候选：`fbcfcd89c1f1b3275b7cb4f28c3e1daba7be132c`。
- 应用 tree：`ef8b2cfb9d8ccf4989b95849de9cf2c2bdce2b3d`。
- 来源：用户上次 Mac mini COMPLETE 回执的 `0bf4c1c0a17afc3a4a380f92958297efd46026b6` / `0068_alert_resource_context`。部署前仍实际核对，回执不是当前状态的替代。
- 目标：`0069_alert_recovery_evidence`；仅新增这一项迁移，不修改旧迁移、依赖或Compose配置。
- 沿用脚本：`deploy/scripts/release-runtime-admin-20260908-mac-mini.sh`。
- 脚本 SHA-256：`3aa287e08f5b795626a3c06dcd29ba48d6e05e459cdd66a4834689492c6047b8`。
- 默认只读预检；构建在停服务前完成，停止写入服务后备份并验证备份目录，再执行迁移、启动和健康检查。
- 失败时不自动down、不自动恢复数据库备份。若0069已完成且尚无恢复证据，允许保留新增列并恢复原应用；已有恢复证据、迁移集合未知或检查失败，则保留备份、数据库与发布锁，停止应用等待处理，禁止旧代码破坏新证据。
- 验证：`bash -n deploy/scripts/release-runtime-admin-20260908-mac-mini.sh` 通过；现有 `node scripts/rehearse-runtime-admin-release.mjs` 20个隔离场景通过，原始结果见 `script-rehearsal.json`。这不是实际服务器部署，不重新进行业务代码全面审核。

## Mac mini 操作

先获取工具并预检：

```bash
release_tools="$(mktemp -d /Users/stephen/qianliu-exception-release.XXXXXX)" &&
git clone --single-branch --branch codex/exception-center-faults-20260908 \
  ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git "$release_tools" &&
test "$(shasum -a 256 "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" | awk '{print $1}')" = 3aa287e08f5b795626a3c06dcd29ba48d6e05e459cdd66a4834689492c6047b8 &&
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --preflight
```

看到 `PREFLIGHT PASS` 后，同一终端执行（会短暂停止应用并升级数据库）：

```bash
bash "$release_tools/deploy/scripts/release-runtime-admin-20260908-mac-mini.sh" --deploy
```

保存并回传最终 `COMPLETE` 输出。若为 `STOP` 或失败，保留完整输出，不删除锁或强行跳过检查。原始部署说明和回执不覆盖。
