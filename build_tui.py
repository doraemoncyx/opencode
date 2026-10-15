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

The build injects OPENCODE_VERSION so the compiled binary reports the repository's
real version. Without this, `Script.version` falls back to `0.0.0-<branch>-<build>`
for any non-`latest` branch, which is below the Console free-tier floor (>= 1.18.0)
and makes model requests fail with
"OpenCode 1.18.0 or newer is required to use the free tier".

OPENCODE_CHANNEL is deliberately NOT set: the Console free-tier gate parses
`User-Agent: opencode/<channel>/<version>/<name>`, which accepts a single channel
segment. Passing a git branch such as `fork/v2_261008` yields a five-segment UA
(`opencode/fork/v2_261008/2.0.29/cli`) that the gate rejects with
"OpenCode's free tier can only be used from within OpenCode". Letting `Script`
default the channel to `latest` (its behavior when OPENCODE_VERSION is set and does
not start with `0.0.0-`) produces `opencode/latest/<version>/cli`, matching official
builds.
"""

import json
import os
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


def run(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(args)}  (cwd={cwd})")
    result = subprocess.run([*bun_command(), *args], cwd=cwd, env=env)
    if result.returncode != 0:
        raise SystemExit(f"command failed (exit code {result.returncode}): {' '.join(args)}")


def main() -> None:
    run(["install"], ROOT)

    # Only set the version. Letting `Script` default the channel to `latest` keeps
    # the User-Agent at `opencode/latest/<version>/cli`, which the Console free-tier
    # gate accepts. A branch-derived channel would add a slash and be rejected.
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    env = {**os.environ, "OPENCODE_VERSION": version}

    try:
        print(f"Building: bun run build --single --skip-install (version {version}, channel latest)")
        run(["run", "build", "--", "--single", "--skip-install"], CLI, env)
        print("Build complete. Output in: packages\\cli\\dist\\cli-windows-x64\\bin\\")
    finally:
        # 构建可能改写 bun.lock 与 package.json，这里还原以保持工作区干净
        subprocess.run(["git", "restore", "--", "bun.lock", "packages/cli/package.json"], cwd=ROOT)


if __name__ == "__main__":
    main()
