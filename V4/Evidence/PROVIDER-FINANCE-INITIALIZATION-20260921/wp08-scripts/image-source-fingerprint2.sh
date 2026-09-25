#!/bin/bash
# WP08 7.1 镜像 ↔ 候选 commit 内容一致性证明（修正版）。
#
# 判据（三分法，而非整集合 DIFF）：
#   MATCH   = git 跟踪文件在镜像内存在且 sha256 全等
#   MISMATCH= git 跟踪文件在镜像内存在但 sha256 不同   ← 必须为 0，否则镜像≠提交
#   ABSENT  = git 跟踪文件不在镜像内                    ← 应恰为"不在该 Dockerfile COPY 面"的文件
#   EXTRA   = 镜像内存在但 git 未跟踪的文件             ← 单独列出并解释
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
HERE=/tmp/wp08/fp2
mkdir -p "$HERE"
TAG=c9bc9b93deb2

echo "# WP08 7.1 镜像 ↔ 候选 commit 内容一致性证明（三分法）"
echo "# 采集时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选 commit:   $(git rev-parse HEAD)"
echo "# 候选 tree:     $(git rev-parse 'HEAD^{tree}')"
echo "# worktree:      $( [ -z "$(git status --porcelain)" ] && echo clean || echo DIRTY )"
echo

# 全仓库跟踪文件清单（含 VERSION / tsconfig.base.json / 各 apps 的 package.json）
: > "$HERE/git-all.tsv"
while IFS= read -r f; do
  [ -f "$f" ] && printf '%s\t%s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
done < <(git ls-files) | LC_ALL=C sort -t$'\t' -k2 > "$HERE/git-all.tsv"
echo "全仓库跟踪文件数: $(wc -l < "$HERE/git-all.tsv" | tr -d ' ')"
echo

classify() {
  SVC=$1
  IMG="qianliu-candidate/${SVC}:${TAG}"
  echo "=================================================================="
  echo "### $SVC   ($IMG)"
  echo "=================================================================="

  docker run --rm --entrypoint sh "$IMG" -c '
    cd /app || exit 1
    find . -type f -not -path "./node_modules/*" -not -path "*/node_modules/*" \
    | sed "s|^\./||" | LC_ALL=C sort \
    | while read -r f; do printf "%s\t%s\n" "$(sha256sum "$f" | awk "{print \$1}")" "$f"; done
  ' | LC_ALL=C sort -t$'\t' -k2 > "$HERE/img-$SVC.tsv"
  echo "-- 镜像内文件数（不含 node_modules）: $(wc -l < "$HERE/img-$SVC.tsv" | tr -d ' ')"

  join -t$'\t' -1 2 -2 2 -o 0,1.1,2.1 "$HERE/git-all.tsv" "$HERE/img-$SVC.tsv" > "$HERE/join-$SVC.tsv"
  awk -F'\t' '$2==$3{print}' "$HERE/join-$SVC.tsv" > "$HERE/match-$SVC.tsv"
  awk -F'\t' '$2!=$3{print}' "$HERE/join-$SVC.tsv" > "$HERE/mismatch-$SVC.tsv"
  comm -23 <(cut -f2 "$HERE/git-all.tsv" | LC_ALL=C sort) \
           <(cut -f2 "$HERE/join-$SVC.tsv" | LC_ALL=C sort) > "$HERE/absent-$SVC.txt"
  comm -13 <(cut -f2 "$HERE/git-all.tsv" | LC_ALL=C sort) \
           <(cut -f2 "$HERE/img-$SVC.tsv" | LC_ALL=C sort) > "$HERE/extra-$SVC.txt"

  echo "-- MATCH   （镜像内跟踪文件 hash 全等）: $(wc -l < "$HERE/match-$SVC.tsv" | tr -d ' ')"
  echo "-- MISMATCH（同路径 hash 不同）        : $(wc -l < "$HERE/mismatch-$SVC.tsv" | tr -d ' ')"
  echo "-- ABSENT  （跟踪文件不在镜像内）      : $(wc -l < "$HERE/absent-$SVC.txt" | tr -d ' ')"
  echo "-- EXTRA   （镜像内非跟踪文件）        : $(wc -l < "$HERE/extra-$SVC.txt" | tr -d ' ')"
  echo
  echo "-- MISMATCH 明细（应为空）"
  cat "$HERE/mismatch-$SVC.tsv"; echo "   (空=无同路径内容差异)"
  echo
  echo "-- ABSENT 明细（应仅为不在该 Dockerfile COPY 面的跟踪文件）"
  cat "$HERE/absent-$SVC.txt" | head -60
  echo "   ... 共 $(wc -l < "$HERE/absent-$SVC.txt" | tr -d ' ') 条"
  echo
  echo "-- ABSENT 中位于 COPY 面（packages/ 或 apps/${SVC}/）的条目（应为 0）"
  grep -E "^packages/|^apps/${SVC}/" "$HERE/absent-$SVC.txt" || echo "   (无 —— COPY 面内跟踪文件无一缺失)"
  echo
  echo "-- EXTRA 明细（按扩展名归类）"
  sed 's/.*\.//' "$HERE/extra-$SVC.txt" | sort | uniq -c | sort -rn | head -10
  echo
}

classify control-api
classify gateway
classify worker

echo "=================================================================="
echo "### web (qianliu-candidate/web:${TAG}) — 运行层仅 nginx + dist"
echo "=================================================================="
docker run --rm --entrypoint sh "qianliu-candidate/web:${TAG}" -c '
  cd /usr/share/nginx/html && find . -type f | LC_ALL=C sort \
  | while read -r f; do sha256sum "$f"; done | LC_ALL=C sort -k2
' > "$HERE/img-web-dist.manifest"
echo "-- 镜像内 dist 文件: $(wc -l < "$HERE/img-web-dist.manifest" | tr -d ' ')"
echo "-- 本地重建对照（vite build → apps/web/dist，已被 .gitignore 忽略）"
export COREPACK_ENABLE_STRICT=0
corepack pnpm@11.11.0 --filter @qianliu/contracts --filter @qianliu/domain run build > "$HERE/web-rebuild.log" 2>&1
corepack pnpm@11.11.0 --filter @qianliu/web run build >> "$HERE/web-rebuild.log" 2>&1
(cd apps/web/dist && find . -type f | LC_ALL=C sort \
  | while read -r f; do shasum -a 256 "$f"; done | LC_ALL=C sort -k2) > "$HERE/local-web-dist.manifest"
echo "-- 本地重建 dist 文件: $(wc -l < "$HERE/local-web-dist.manifest" | tr -d ' ')"
echo
echo "-- 镜像独有（应为 nginx 基础镜像自带文件）"
comm -13 <(cut -f2 "$HERE/local-web-dist.manifest" | LC_ALL=C sort) \
         <(cut -f2 "$HERE/img-web-dist.manifest" | LC_ALL=C sort)
echo "-- 本地重建独有（应为空）"
comm -23 <(cut -f2 "$HERE/local-web-dist.manifest" | LC_ALL=C sort) \
         <(cut -f2 "$HERE/img-web-dist.manifest" | LC_ALL=C sort)
echo "-- 共有文件 hash 差异（应为空）"
join -t$'\t' -j 2 -o 0,1.1,2.1 <(sed 's/  /\t/' "$HERE/local-web-dist.manifest" | LC_ALL=C sort -t$'\t' -k2) \
                                   <(sed 's/  /\t/' "$HERE/img-web-dist.manifest" | LC_ALL=C sort -t$'\t' -k2) \
  | awk -F'\t' '$2!=$3'
echo "   (以上为空 ⇒ 共有产物逐字节相同)"
echo "-- 镜像内 nginx 反代配置指纹"
docker run --rm --entrypoint sh "qianliu-candidate/web:${TAG}" -c 'sha256sum /etc/nginx/conf.d/default.conf'
echo
echo "### 复核：重建后 worktree 是否仍干净"
if [ -z "$(git status --porcelain)" ]; then echo "WORKTREE=clean"; else echo "WORKTREE=DIRTY"; git status --porcelain | head; fi
