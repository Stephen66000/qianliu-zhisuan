#!/usr/bin/env python3
"""
M5 评审候选锁生成器 —— 对 M5 交付物（代码 + Evidence + 计划文档）计算 sha256。

用法（仓库根目录）：
    python3 V3/tools/candidate_lock.py generate

输出：V3/仟流智算-M5评审候选锁-v0.3.sha256
任一受封文件字节变化，锁立即失效（Reviewer 重算比对即可验证完整性）。
"""
import hashlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 封板范围：M5 全部交付物
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
    "V3/Evidence/M5/W18/W18前端-Evidence-20260728.md",
    "V3/Evidence/M5/W19/W19-Evidence-20260728.md",
    "V3/Evidence/M5/W20/W20-Evidence-20260728.md",
    "V3/Evidence/M5/M5-收口执行清单-20260728.md",
    "V3/Evidence/M5/Win11-实机回归-20260728.md",
]

# 代码目录（递归封板，排除 node_modules/dist/测试残留）
CODE_DIRS = ["apps", "packages"]
EXCLUDE_DIRS = {"node_modules", "dist", "test-results", "playwright-report", ".stryker-tmp", "__MACOSX"}
EXCLUDE_FILES = {".DS_Store"}
INCLUDE_EXTS = {".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".html", ".css"}


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


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] != "generate":
        print(__doc__)
        return 2
    files = collect()
    out_path = os.path.join(ROOT, "V3/仟流智算-M5评审候选锁-v0.3.sha256")
    lines = [
        "# M5 评审候选锁 —— M5（W18/W19/W20）交付物完整性封板。",
        "# 任一受封文件字节变化，本锁立即失效。双审 Reviewer 重算比对即可验证。",
        "# 范围：计划/规则文档 + M5 Evidence + apps/packages 全部源码。",
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
    print(f"已生成：{os.path.relpath(out_path, ROOT)}（{len(files) - len(missing)} 文件）")
    if missing:
        print("缺失（未封入）：")
        for m in missing:
            print(f"  - {m}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
