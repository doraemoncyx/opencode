#!/usr/bin/env python3
"""Build Windows opencode CLI/TUI (single platform, win32-x64).

Usage: python build_tui.py

Deps are installed once at the repo root. The actual `bun run build` is
invoked with `--single --skip-install`:
  --single        only bundle the current platform/arch (win32-x64), so the
                  build only targets the host instead of every OS/arch.
  --skip-install  skip build.ts's `bun install --os="*" --cpu="*"` cross-platform
                  re-fetch, which hits a Windows cache-move EPERM when re-extracting
                  the `@opencode-ai/client` file: tarball; deps are already installed
                  by `bun install` above.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLI = ROOT / "packages" / "cli"


def bun_command() -> list[str]:
    exe = shutil.which("bun")
    if exe is None:
        sys.exit("bun not found on PATH")
    # .cmd/.bat shims must go through cmd.exe on Windows
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe]
    return [exe]


def run(args: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(args)}  (cwd={cwd})")
    result = subprocess.run([*bun_command(), *args], cwd=cwd)
    if result.returncode != 0:
        raise SystemExit(f"command failed (exit code {result.returncode}): {' '.join(args)}")


def main() -> None:
    run(["install"], ROOT)

    try:
        print("Building: bun run build --single --skip-install")
        run(["run", "build", "--", "--single", "--skip-install"], CLI)
        print("Build complete. Output in: packages\\cli\\dist\\cli-windows-x64\\bin\\")
    finally:
        # 构建可能改写 bun.lock 与 package.json，这里还原以保持工作区干净
        subprocess.run(["git", "restore", "--", "bun.lock", "packages/cli/package.json"], cwd=ROOT)


if __name__ == "__main__":
    main()
