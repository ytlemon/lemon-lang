#!/usr/bin/env python3
"""定位并调用本地 Lemon 解释器。

查找顺序：
  1. --lemon <路径> 显式指定
  2. 环境变量 LEMON_EXECUTABLE
  3. <仓库>/dist/lemon.exe                       （Node SEA 独立可执行文件）
  4. <仓库>/dist/lemon.cjs   + node               （esbuild 打包产物）
  5. <仓库>/bin/lemon.js     + node
  6. 系统 PATH 中的 lemon / lemon.exe
其中 <仓库> 依次取「本技能包所在仓库」与「当前工作目录向上 6 层」。

用法：
  python lemon_run.py run demo.lemon1
  python lemon_run.py check --json demo.lemon1
  python lemon_run.py eval "say(你好)"
  python lemon_run.py --print-command run demo.lemon1      # 只打印将执行的命令

参数原样转发给 lemon；stdout/stderr 与退出码同样原样透传。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SEARCH_DEPTH = 6


def skill_root() -> Path:
    """技能包目录：<repo>/.codebuddy/skills/lemon-lang"""
    return Path(__file__).resolve().parent.parent


def repo_candidates() -> list[Path]:
    roots: list[Path] = []
    try:
        # <repo>/.codebuddy/skills/lemon-lang -> 上溯三层即仓库根
        roots.append(skill_root().parents[2])
    except IndexError:
        pass

    here = Path.cwd().resolve()
    roots.append(here)
    roots.extend(list(here.parents)[:SEARCH_DEPTH])

    seen: set[Path] = set()
    ordered: list[Path] = []
    for root in roots:
        if root not in seen:
            seen.add(root)
            ordered.append(root)
    return ordered


def node_binary() -> str | None:
    return shutil.which("node") or shutil.which("node.exe")


def find_lemon(explicit: str | None) -> tuple[list[str] | None, str]:
    """返回 (命令前缀, 说明)；找不到时命令前缀为 None。"""
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            return None, f"--lemon 指定的文件不存在：{path}"
        return [str(path)], "命令行参数"

    env = os.environ.get("LEMON_EXECUTABLE", "").strip()
    if env:
        if not Path(env).is_file():
            return None, f"环境变量 LEMON_EXECUTABLE 指向的文件不存在：{env}"
        return [env], "环境变量 LEMON_EXECUTABLE"

    exe_name = "lemon.exe" if os.name == "nt" else "lemon"
    for root in repo_candidates():
        sea = root / "dist" / exe_name
        if sea.is_file():
            return [str(sea)], f"{sea}"

    node = node_binary()
    for root in repo_candidates():
        bundle = root / "dist" / "lemon.cjs"
        if bundle.is_file() and node:
            return [node, str(bundle)], f"{bundle}（经 node）"
        script = root / "bin" / "lemon.js"
        if script.is_file() and node:
            return [node, str(script)], f"{script}（经 node）"

    on_path = shutil.which("lemon") or shutil.which("lemon.exe")
    if on_path:
        return [on_path], "系统 PATH"

    return None, "未找到 Lemon 解释器"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="定位并调用本地 Lemon 解释器",
        epilog="未列出的参数会原样转发给 lemon，例如 run / check / eval / ast / tokens。",
    )
    parser.add_argument("--lemon", help="显式指定 lemon 可执行文件路径")
    parser.add_argument(
        "--print-command",
        action="store_true",
        help="只打印将要执行的命令，不真正执行",
    )
    known, forwarded = parser.parse_known_args(argv)

    prefix, origin = find_lemon(known.lemon)
    if prefix is None:
        print(f"错误：{origin}", file=sys.stderr)
        print(
            "请先构建解释器（在仓库根执行 npm install && npm run build），"
            "或用 --lemon 指定路径。",
            file=sys.stderr,
        )
        return 2

    if not forwarded:
        forwarded = ["--help"]

    command = [*prefix, *forwarded]

    if known.print_command:
        print(" ".join(command))
        print(f"# 解释器来源：{origin}", file=sys.stderr)
        return 0

    try:
        if sys.stdin.isatty():
            # 交互场景（如 REPL）：直接继承标准流
            completed = subprocess.run(command)
        else:
            # 管道场景：按字节透传，避免 Windows 控制台代码页破坏 UTF-8 中文
            completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            sys.stdout.buffer.write(completed.stdout or b"")
            sys.stdout.buffer.flush()
            sys.stderr.buffer.write(completed.stderr or b"")
            sys.stderr.buffer.flush()
    except KeyboardInterrupt:
        return 130
    except OSError as error:
        print(f"错误：无法执行 {command[0]}：{error}", file=sys.stderr)
        return 2

    return completed.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
