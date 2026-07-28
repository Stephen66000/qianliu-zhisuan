#!/usr/bin/env python3
"""
M5 评审候选锁生成器 —— 对 M5 交付物（代码 + Evidence + 计划文档）计算 sha256。

用法（仓库根目录）：
    python3 V3/tools/candidate_lock.py generate
    python3 V3/tools/candidate_lock.py verify

输出：V3/仟流智算-M5评审候选锁-v0.3.sha256
任一受封文件字节变化，锁立即失效（Reviewer 重算比对即可验证完整性）。
"""
import hashlib
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCK_REL = "V3/仟流智算-M5评审候选锁-v0.3.sha256"

# 封板范围：M5 全部交付物（文档/Evidence）+ 根级依赖与构建输入 + 生成器与任务书自身
SEAL_PATHS = [
    # 计划/规则文档（M5 依据）
    "V3/仟流智算-产品需求文档-v0.3.md",
    "V3/仟流智算-技术需求文档-v0.3.md",
    "V3/仟流智算-详细开发计划与排期-v0.3.md",
    "V3/仟流智算-项目工程规则-v0.3.md",
    "V3/仟流智算-stage-state-v0.3.yaml",
    "V3/Planning-Change-Log.md",
    # M5 Evidence
    "V3/Evidence/M5/M5-W18前端-handoff-20260728.md",
    "V3/Evidence/M5/M5-整改-handoff-to-codex-20260728.md",
    "V3/Evidence/M5/W18/W18前端-Evidence-20260728.md",
    "V3/Evidence/M5/W19/W19-Evidence-20260728.md",
    "V3/Evidence/M5/W20/W20-Evidence-20260728.md",
    "V3/Evidence/M5/M5-收口执行清单-20260728.md",
    "V3/Evidence/M5/Win11-实机回归-20260728.md",
    "V3/Evidence/M5/M5-双审任务书-20260728.md",
    "V3/Evidence/M5/M5-双审整改-Evidence-20260728.md",
    # 根级依赖与构建输入（P1-01：之前漏封）
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "eslint.config.mjs",
    "tsconfig.base.json",
    "vitest.config.ts",
    ".npmrc",
    # 生成器自身（可审计）
    "V3/tools/candidate_lock.py",
]

# 代码目录（递归封板，排除 node_modules/dist/测试残留）
CODE_DIRS = ["apps", "packages"]
EXCLUDE_DIRS = {"node_modules", "dist", "test-results", "playwright-report", ".stryker-tmp", "__MACOSX"}
EXCLUDE_FILES = {".DS_Store"}
INCLUDE_EXTS = {".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".html", ".css"}


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
    except Exception:
        return "UNKNOWN"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect() -> list[str]:
    files = list(SEAL_PATHS)
    for base in CODE_DIRS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, base)):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for name in filenames:
                if name in EXCLUDE_FILES:
                    continue
                ext = os.path.splitext(name)[1]
                if ext in INCLUDE_EXTS:
                    full = os.path.join(dirpath, name)
                    files.append(os.path.relpath(full, ROOT))
    return sorted(set(files))


def generate() -> int:
    commit = git_commit()
    files = collect()
    out_path = os.path.join(ROOT, LOCK_REL)
    lines = [
        "# M5 评审候选锁 —— M5（W18/W19/W20）交付物完整性封板。",
        "# 任一受封文件字节变化，本锁立即失效。双审 Reviewer 重算比对即可验证。",
        "# 范围：计划/规则文档 + M5 Evidence + 根级依赖/构建输入 + apps/packages 全部源码 + 生成器自身。",
        f"# Git commit：{commit}",
        f"# 文件数：{len(files)}",
        "",
    ]
    missing = []
    for rel in files:
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full):
            missing.append(rel)
            continue
        lines.append(f"{sha256_file(full)}  {rel}")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"已生成：{os.path.relpath(out_path, ROOT)}（{len(files) - len(missing)} 文件，commit {commit[:8]}）")
    if missing:
        print("缺失（未封入）：")
        for m in missing:
            print(f"  - {m}")
        return 1
    return 0


def verify() -> int:
    out_path = os.path.join(ROOT, LOCK_REL)
    if not os.path.isfile(out_path):
        print(f"锁文件不存在：{LOCK_REL}")
        return 1

    locked_commit = ""
    locked: dict[str, str] = {}
    with open(out_path, encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            if line.startswith("# Git commit："):
                locked_commit = line.removeprefix("# Git commit：").strip()
            elif line and not line.startswith("#"):
                digest, separator, rel = line.partition("  ")
                if not separator or len(digest) != 64 or not rel:
                    print(f"锁文件格式错误：{line}")
                    return 1
                locked[rel] = digest

    current_files = collect()
    if set(current_files) != set(locked):
        added = sorted(set(current_files) - set(locked))
        removed = sorted(set(locked) - set(current_files))
        print(f"封板范围不一致：新增 {len(added)}，缺失 {len(removed)}")
        for rel in added:
            print(f"  + {rel}")
        for rel in removed:
            print(f"  - {rel}")
        return 1

    mismatches = []
    for rel in current_files:
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full) or sha256_file(full) != locked[rel]:
            mismatches.append(rel)
    if mismatches:
        print(f"SHA-256 不一致：{len(mismatches)} 文件")
        for rel in mismatches:
            print(f"  ! {rel}")
        return 1

    if not locked_commit:
        print("锁头缺少 Git commit")
        return 1
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", locked_commit, "HEAD"],
        cwd=ROOT,
        check=False,
    )
    if ancestry.returncode != 0:
        print(f"锁定 commit 不是当前 HEAD 的祖先：{locked_commit}")
        return 1
    status = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=ROOT,
        text=True,
    )
    if status.strip():
        print("工作树不干净，拒绝通过候选锁验证")
        return 1

    print(
        f"候选锁验证通过：{len(current_files)} 文件，"
        f"candidate {locked_commit[:8]}，carrier {git_commit()[:8]}"
    )
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    if sys.argv[1] == "generate":
        return generate()
    if sys.argv[1] == "verify":
        return verify()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
