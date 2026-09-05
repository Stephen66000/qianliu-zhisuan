# Mac Mini 升级说明

本轮代码分支：`codex/quota-pricing-review-20260905`。不创建 PR、不合并 main。

升级来源固定为用户已部署的 `7b2701442c2bd5e83709c6282d549d4a5a581cbe`，原迁移头为 0063，目标为 `0064_quota_pricing_and_policy_archive`。脚本不适用于其他起始发布；校验不符时停止，先核对现场。

## 1. 下载候选并只读检查

在 Mac Mini 终端运行。此阶段只下载代码、查询现有规则与账本，不停服务、不执行迁移。保留输出的 `review_dir`，下一步会继续使用。

```bash
set -e
review_dir="$(mktemp -d /Users/stephen/quota-pricing-check.XXXXXX)"
git clone --depth 64 --branch codex/quota-pricing-review-20260905 \
  git@github.com:Stephen66000/qianliu-zhisuan.git "$review_dir"
git -C "$review_dir" log -1 --format='%H %s'
git -C "$review_dir" rev-parse 'HEAD^{tree}'
current_release="$(< /Users/stephen/qianliu-current-release.txt)"
case "$current_release" in /Users/stephen/releases/*) ;; *) echo '发布目录不符合预期'; exit 1;; esac
test "$(git -C "$current_release" rev-parse HEAD)" = 7b2701442c2bd5e83709c6282d549d4a5a581cbe
docker compose --project-directory "$current_release/deploy" exec -T postgres \
  sh -lc 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$review_dir/deploy/scripts/quota-pricing-preflight.sql"
printf 'review_dir=%s\n' "$review_dir"
```

核对候选 SHA 与交付消息一致；检查现有 API 绝对高峰价、套餐倍率、已发布的倍率策略。修复后现有倍率策略会按真实规则开始判断，需确认它们仍符合当前业务意图。旧绝对高峰价不会自动再乘一次倍率；切换为倍率模式须在页面明确创建新版本并替换旧规则集。

## 2. 执行升级

只读检查完成后，在同一个终端会话运行。若换了终端，先将 `review_dir` 设置为上一步输出的实际目录。

```bash
test -n "$review_dir"
test -f "$review_dir/deploy/scripts/release-quota-pricing-20260905-mac-mini.sh"
CANDIDATE_COMMIT="$(git -C "$review_dir" rev-parse HEAD)" \
CANDIDATE_TREE="$(git -C "$review_dir" rev-parse 'HEAD^{tree}')" \
  bash "$review_dir/deploy/scripts/release-quota-pricing-20260905-mac-mini.sh"
```

脚本验证候选 Commit/Tree、旧发布与容器目录、唯一允许的 0064 迁移和不变的部署拓扑；在线构建后暂停业务，生成并验证数据库备份，再执行迁移、启动和健康检查，最后切换发布指针。

脚本返回 COMPLETE 才表示发布流程完成。保留最后一行 Commit、Tree、migration、health、backup 和 backup_sha256。

## 3. 回退和验收

脚本失败先确认停止业务。若查询确认数据库没有新倍率规则，可恢复旧应用镜像，保留已执行的兼容增量结构；如果已经有新倍率规则，或数据库查询失败/结果不明，则保持停写，需前滚修复。不能让旧 Gateway 解释新倍率规则。

不自动执行 migration down，也不将备份覆盖回现有数据库。备份用于独立核查及另行确认的恢复操作，避免覆盖部署后的真实消费。

发布后验证：

1. 计价与调度两个 Tab、规则整套复制、一次保存启用。
2. 原有模型和账号正常调用，价格币种及单位准确。
3. 普通/高峰时段分别抽样，核对真实输入输出 Token、倍率、分项费用、逐次账本和请求合计。
4. 策略拒绝在上游前不产生消费；真实流中断等已发生消费不能抹成零。
5. 策略停用后存档，默认隐藏、存档视图可查；历史账本未随新规则改变。

真实高峰样本未取得时保留“待验收”状态。健康全部通过只证明服务已启动。
