#!/usr/bin/env python3
"""把 fork 的个人分支同步到 upstream 最新（默认 squash + rebase + force push）。

Usage:
  python sync_git.py                  # 默认 rebase 模式
  python sync_git.py --merge          # 用 merge 代替 rebase
  python sync_git.py --branch v2 --fork origin --upstream upstream

流程：
  1. upstream remote 缺失时按 --upstream-url 添加
  2. checkout 目标分支，git reset --hard 丢弃未提交修改
  3. fetch upstream 对应分支
  4. 默认模式：把本地领先的个人提交 squash 成一条再 rebase 到 upstream，
     最后 force-with-lease 推送到 fork；--merge 模式则 merge 后普通 push

squash 的原因：本地个人提交越多，rebase 需要重放的提交越多、越慢，压成一条
后 rebase 只需重放 1 条。

rebase 因冲突暂停时只提示手动处理并退出，绝不继续 force push。
"""

import argparse
import ctypes
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# 默认目标：v2 仓库里 fork 是 origin、upstream 是 upstream、两边分支都叫 v2
DEFAULT_BRANCH = "v2"
DEFAULT_FORK = "origin"
DEFAULT_UPSTREAM = "upstream"
DEFAULT_UPSTREAM_BRANCH = "v2"
DEFAULT_UPSTREAM_URL = "git@github.com:anomalyco/opencode.git"

RESET = "\033[0m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"


def log(message: str, color: str = "") -> None:
    # 只在交互式终端着色，重定向到文件时保持纯文本
    if color and sys.stdout.isatty():
        print(f"{color}{message}{RESET}")
        return
    print(message)


def git(args: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def git_checked(args: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    # 关键步骤失败即中止，避免在错误状态下继续 rebase / push
    result = git(args, capture)
    if result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} 失败（退出码 {result.returncode}）")
    return result


def git_probe(args: list[str]) -> str | None:
    # 用于「失败属正常」的探测，例如 remote/branch 是否存在
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def use_utf8_console() -> int | None:
    # git 会输出 UTF-8 的中文提交信息，默认 GBK 控制台会乱码；
    # 把控制台代码页切到 UTF-8，返回原代码页供还原（非 Windows 或无控制台时为 None）。
    previous = None
    if os.name == "nt":
        try:
            previous = ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        except OSError:
            previous = None
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    return previous


def restore_console(codepage: int | None) -> None:
    if codepage:
        ctypes.windll.kernel32.SetConsoleOutputCP(codepage)


def rebase_in_progress() -> bool:
    git_dir = git_probe(["rev-parse", "--git-dir"])
    if git_dir is None:
        return False
    path = Path(git_dir)
    if not path.is_absolute():
        path = ROOT / path
    return (path / "rebase-merge").exists() or (path / "rebase-apply").exists()


def main() -> None:
    parser = argparse.ArgumentParser(description="同步 fork 分支到 upstream 最新")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--rebase", action="store_true", help="squash 后 rebase 再 force push（默认）")
    mode.add_argument("--merge", action="store_true", help="直接 merge upstream 再普通 push")
    parser.add_argument("--branch", default=DEFAULT_BRANCH, help=f"要同步的本地/fork 分支（默认 {DEFAULT_BRANCH}）")
    parser.add_argument("--fork", default=DEFAULT_FORK, help=f"fork remote 名（默认 {DEFAULT_FORK}）")
    parser.add_argument("--upstream", default=DEFAULT_UPSTREAM, help=f"upstream remote 名（默认 {DEFAULT_UPSTREAM}）")
    parser.add_argument(
        "--upstream-branch",
        default=DEFAULT_UPSTREAM_BRANCH,
        help=f"upstream 上要同步的分支（默认 {DEFAULT_UPSTREAM_BRANCH}）",
    )
    parser.add_argument("--upstream-url", default=DEFAULT_UPSTREAM_URL, help="缺少 upstream remote 时使用的地址")
    args = parser.parse_args()

    upstream_ref = f"{args.upstream}/{args.upstream_branch}"
    codepage = use_utf8_console()
    try:
        if git_probe(["remote", "get-url", args.upstream]) is None:
            git_checked(["remote", "add", args.upstream, args.upstream_url])
            log(f"已添加 {args.upstream} remote", CYAN)

        if git_probe(["branch", "--show-current"]) != args.branch:
            git_checked(["checkout", args.branch])

        git_checked(["reset", "--hard"])
        log("已丢弃本地未提交修改", CYAN)

        log(f"正在 fetch {upstream_ref} ...", CYAN)
        git_checked(["fetch", args.upstream, args.upstream_branch])

        if args.merge:
            log(f"正在 merge {upstream_ref} ...", YELLOW)
            git_checked(["merge", upstream_ref, "--no-edit"])
            log(f"正在推送到 {args.fork} ...", CYAN)
            git_checked(["push", args.fork, args.branch])
            return

        ahead = int(git_probe(["rev-list", "--count", f"{upstream_ref}..{args.branch}"]) or "0")
        if ahead > 1:
            log("正在把本地提交压缩成一条 ...", YELLOW)
            git_checked(["reset", "--soft", upstream_ref])
            git_checked(["commit", "-m", f"feat({args.branch}): fork 累积改动"])

        log(f"正在 rebase 到 {upstream_ref} ...", YELLOW)
        result = git(["rebase", upstream_ref])
        if result.returncode != 0:
            # 冲突时 rebase 会暂停在中间，交由用户手动解决，绝不继续 force push
            if rebase_in_progress():
                log(
                    "Rebase 因冲突暂停：请手动解决冲突后运行 'git rebase --continue'，"
                    "或运行 'git rebase --abort' 放弃本次同步。",
                    RED,
                )
                raise SystemExit(1)
            raise SystemExit(f"git rebase 失败（退出码 {result.returncode}）")

        log(f"正在 force push 到 {args.fork} ...", CYAN)
        git_checked(["push", args.fork, args.branch, "--force-with-lease"])
    finally:
        restore_console(codepage)


if __name__ == "__main__":
    main()
