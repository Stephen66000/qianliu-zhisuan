#!/bin/bash
# WP08 7.1 镜像↔提交一致性证明。
#
# 方法：把每个候选镜像内**实际装载**的文件逐个 sha256，与「候选 commit 的 git 跟踪文件」
# 在同一路径上的 sha256 逐行 diff。逐文件相等 ⇒ 镜像内容 = 候选源码树，
# 而不是"容器名 / 构建缓存"的推断。
#
# control-api / gateway / worker：单阶段 tsx 镜像，镜像内 /app 直接持源码 → 直接比对源码。
# web：两阶段镜像，运行层只有 nginx + 构建产物 dist（不含源码）→ 比对 dist 与本地重建产物。
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
HERE=/tmp/wp08/fp
mkdir -p "$HERE"
TAG=c9bc9b93deb2

echo "# WP08 7.1 镜像 ↔ 候选 commit 内容一致性证明"
echo "# 采集时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选 commit:   $(git rev-parse HEAD)"
echo "# 候选 tree:     $(git rev-parse 'HEAD^{tree}')"
echo "# worktree:      $( [ -z "$(git status --porcelain)" ] && echo clean || echo DIRTY )"
echo "# 方法: 镜像内 find+sha256sum 清单 vs git 跟踪文件 sha256 清单（逐行 diff）"
echo "# 比对范围: packages/** + apps/<svc>/** + tsconfig.base.json + VERSION（Dockerfile COPY 面）"
echo

# ---------- 主机侧：git 跟踪文件的 sha256 清单 ----------
git ls-files packages apps | grep -v "/node_modules/" > "$HERE/tracked.txt"
: > "$HERE/git-all.manifest"
while IFS= read -r f; do
  [ -f "$f" ] && shasum -a 256 "$f"
done < "$HERE/tracked.txt" | LC_ALL=C sort -k2 > "$HERE/git-all.manifest"
echo "跟踪文件清单条目数: $(wc -l < "$HERE/git-all.manifest" | tr -d ' ')"
echo

for SVC in control-api gateway worker; do
  IMG="qianliu-candidate/${SVC}:${TAG}"
  echo "=================================================================="
  echo "### $SVC  ($IMG)"
  echo "=================================================================="
  docker run --rm --entrypoint sh "$IMG" -c '
    cd /app || exit 1
    { find packages -type f; find apps -type f;
      [ -f tsconfig.base.json ] && echo tsconfig.base.json;
      [ -f VERSION ] && echo VERSION; } \
    | grep -v "/node_modules/" | LC_ALL=C sort \
    | while read -r f; do sha256sum "$f"; done | LC_ALL=C sort -k2
  ' > "$HERE/img-$SVC.manifest" 2> "$HERE/img-$SVC.err"
  echo "-- 镜像内 /app 源码文件数: $(wc -l < "$HERE/img-$SVC.manifest" | tr -d ' ')"

  awk -v svc="$SVC" '
    { p=$2; if (p ~ /^packages\// || p=="tsconfig.base.json" || p=="VERSION" || index(p,"apps/" svc "/")==1) print }
  ' "$HERE/git-all.manifest" | LC_ALL=C sort -k2 > "$HERE/expected-$SVC.manifest"
  echo "-- 应装载的跟踪文件数:     $(wc -l < "$HERE/expected-$SVC.manifest" | tr -d ' ')"

  if diff -q "$HERE/expected-$SVC.manifest" "$HERE/img-$SVC.manifest" >/dev/null; then
    echo "   ★ 结论: IDENTICAL（逐文件 hash 全等）"
    echo "   ★ 清单指纹 sha256: $(shasum -a 256 < "$HERE/img-$SVC.manifest" | awk '{print $1}')"
  else
    echo "   ✗ 结论: DIFFERS"
    echo "   -- 仅镜像有（非跟踪/多余文件，前 20 行）"
    comm -13 "$HERE/expected-$SVC.manifest" "$HERE/img-$SVC.manifest" | head -20
    echo "   -- 仅 git 有（镜像缺失，前 20 行）"
    comm -23 "$HERE/expected-$SVC.manifest" "$HERE/img-$SVC.manifest" | head -20
    echo "   -- 同路径内容不同（前 20 行）"
    join -j 2 -o 1.1,2.1,0 "$HERE/expected-$SVC.manifest" "$HERE/img-$SVC.manifest" 2>/dev/null \
      | awk '$1!=$2{print $3}' | head -20
  fi
  echo
done

# ---------- web：运行层 dist 清单 vs 本地重建 ----------
echo "=================================================================="
echo "### web  (qianliu-candidate/web:${TAG}) — 运行层为 nginx 静态产物，比对 dist"
echo "=================================================================="
docker run --rm --entrypoint sh "qianliu-candidate/web:${TAG}" -c '
  cd /usr/share/nginx/html && find . -type f | LC_ALL=C sort \
  | while read -r f; do sha256sum "$f"; done | LC_ALL=C sort -k2
' > "$HERE/img-web-dist.manifest" 2> "$HERE/img-web-dist.err"
echo "-- 镜像内 dist 文件数: $(wc -l < "$HERE/img-web-dist.manifest" | tr -d ' ')"
echo "-- 镜像内 nginx 配置指纹:"
docker run --rm --entrypoint sh "qianliu-candidate/web:${TAG}" -c 'sha256sum /etc/nginx/conf.d/default.conf'
echo
echo "本地重建 web 产物（vite build，产物落 apps/web/dist，已被 .gitignore 忽略）："
export COREPACK_ENABLE_STRICT=0
corepack pnpm@11.11.0 --filter @qianliu/contracts --filter @qianliu/domain run build > "$HERE/web-rebuild.log" 2>&1
corepack pnpm@11.11.0 --filter @qianliu/web run build >> "$HERE/web-rebuild.log" 2>&1
echo "  重建退出码: $?"
tail -4 "$HERE/web-rebuild.log"
if [ -d apps/web/dist ]; then
  (cd apps/web/dist && find . -type f | LC_ALL=C sort \
    | while read -r f; do shasum -a 256 "$f"; done | LC_ALL=C sort -k2) > "$HERE/local-web-dist.manifest"
  echo "-- 本地重建 dist 文件数: $(wc -l < "$HERE/local-web-dist.manifest" | tr -d ' ')"
  if diff -q "$HERE/local-web-dist.manifest" "$HERE/img-web-dist.manifest" >/dev/null; then
    echo "   ★ 结论: IDENTICAL（镜像 dist = 由候选树本地重建的 dist）"
    echo "   ★ 清单指纹 sha256: $(shasum -a 256 < "$HERE/img-web-dist.manifest" | awk '{print $1}')"
  else
    echo "   ✗ 结论: DIFFERS"
    diff -u "$HERE/local-web-dist.manifest" "$HERE/img-web-dist.manifest" | head -30
  fi
else
  echo "   ✗ 本地重建未产出 dist，无法比对"
fi
echo
echo "### 复核：重建后 worktree 是否仍干净（dist 属构建产物，不应污染候选树）"
if [ -z "$(git status --porcelain)" ]; then echo "WORKTREE=clean"; else echo "WORKTREE=DIRTY"; git status --porcelain | head; fi
