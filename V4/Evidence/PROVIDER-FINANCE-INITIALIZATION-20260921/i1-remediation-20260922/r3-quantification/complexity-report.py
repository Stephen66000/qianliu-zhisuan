#!/usr/bin/env python3
"""资金核心路径复杂度度量（I1 复审 R3 Evidence Gap 整改）。

对 provider-finance-activation* 模块逐函数计算：
- cyclomatic complexity（圈复杂度，CC）：if/for/while/case/except/and/or/三元 各 +1；
- cognitive complexity（认知复杂度，SonarSource 语义近似：嵌套惩罚）；
- CRAP = CC^2 * (1-coverage)^3 + CC（配合覆盖率 JSON）。

输出 markdown 报告到 stdout；覆盖率来源为 v8 coverage-summary.json（可选参数 2）。
仅依赖 Python 标准库，可独立复现。
"""
import json
import re
import sys
from pathlib import Path


def strip_strings_and_comments(src: str) -> str:
    """移除字符串字面量与注释，避免其中的关键字干扰计数。"""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c in ("'", '"', "`"):
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            out.append(" ")
            continue
        if c == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            out.append(" ")
            continue
        out.append(c)
        i += 1
    return "".join(out)


CC_KEYWORDS = re.compile(r"\b(if|for|while|case|catch)\b|\band\b|\bor\b|\?\?|\?[^.?:]|\belse\s+if\b")


def function_blocks(clean: str):
    """按 function/method 关键字粗粒度切分函数块（TS 源，花括号配对）。"""
    for m in re.finditer(
        r"(?:export\s+)?(?:async\s+)?function\s+(\w+)|(\w+)\s*\([^)]*\)\s*\{", clean
    ):
        name = m.group(1) or m.group(2)
        brace_open = clean.find("{", m.start())
        if brace_open == -1:
            continue
        depth, i = 1, brace_open + 1
        while i < len(clean) and depth > 0:
            if clean[i] == "{":
                depth += 1
            elif clean[i] == "}":
                depth -= 1
            i += 1
        yield name, clean[brace_open:i], brace_open


def complexity_of(body: str) -> tuple[int, int]:
    """返回 (cyclomatic, cognitive)。认知复杂度：控制流关键字按嵌套深度加罚。"""
    cc = 1
    cognitive = 0
    depth = 0
    i = 0
    tokens = list(re.finditer(
        r"\b(if|for|while|case|catch)\b|\band\b|\bor\b|\?\?|\?[^.?:]|\{|\}", body))
    for t in tokens:
        tok = t.group(0)
        if tok == "{":
            depth += 1
            continue
        if tok == "}":
            depth -= 1
            continue
        cc += 1
        cognitive += 1 + max(depth - 1, 0)
    return cc, cognitive


def main() -> None:
    repo = Path(sys.argv[1])
    files = sorted((repo / "packages/domain/src").glob("provider-finance-activation*.ts"))
    summary_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    coverage = {}
    if summary_path and summary_path.exists():
        raw = json.loads(summary_path.read_text())
        for key, val in raw.items():
            short = key.rsplit("/", 1)[-1]
            coverage[short] = val["lines"]["pct"] / 100.0

    print("| 文件 | 函数 | CC | cognitive | CRAP | 行覆盖 |")
    print("|---|---|---|---|---|---|")
    worst = []
    for path in files:
        clean = strip_strings_and_comments(path.read_text())
        for name, body, _pos in function_blocks(clean):
            cc, cog = complexity_of(body)
            cov = coverage.get(path.name, 0.0)
            crap = round(cc * cc * (1 - cov) ** 3 + cc, 2)
            worst.append((crap, cc, cog, path.name, name, cov))
            print(f"| {path.name} | {name} | {cc} | {cog} | {crap} | {cov:.0%} |")

    worst.sort(reverse=True)
    print("\n## 复杂度 TOP10（按 CRAP）\n")
    print("| CRAP | CC | cognitive | 文件.函数 | 覆盖 |")
    print("|---|---|---|---|---|")
    for crap, cc, cog, fname, name, cov in worst[:10]:
        print(f"| {crap} | {cc} | {cog} | {fname}.{name} | {cov:.0%} |")
    if worst:
        cc_max = max(w[1] for w in worst)
        cog_max = max(w[2] for w in worst)
        print(f"\nMAX_CC={cc_max}  MAX_COGNITIVE={cog_max}  FUNCTIONS={len(worst)}")


if __name__ == "__main__":
    main()
