#!/usr/bin/env python
"""startdev.py - run the OpenCode web app Vite dev server against a running backend.

The Vite dev server serves the app from source with hot module replacement, so UI
edits show up on refresh without rebuilding `dist` or restarting the `opencode
serve` process. It talks to a backend chosen by VITE_OPENCODE_SERVER_PORT
(default 4096); point it at your own `bun dev serve --port <N>` with --server-port.

Backend host precedence: --server-host > $VITE_OPENCODE_SERVER_HOST > localhost.

Examples:
  startdev.py                       # app on :4444 -> backend :4096
  startdev.py --server-port 4098    # app on :4444 -> backend :4098
  startdev.py -p 5173 -s 4098       # app on :5173 -> backend :4098
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_app_dir(start: Path) -> Path | None:
    """Walk up from `start` looking for packages/app/vite.config.ts."""
    current = start.resolve()
    for parent in (current, *current.parents):
        candidate = parent / "packages" / "app" / "vite.config.ts"
        if candidate.is_file():
            return parent / "packages" / "app"
    return None


def resolve_app_dir(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not (path / "vite.config.ts").is_file():
            sys.exit(f"startdev: {path} has no vite.config.ts (is this packages/app?)")
        return path
    # This script lives at packages/app/script, so its parent is packages/app.
    beside_script = Path(__file__).resolve().parent.parent
    if (beside_script / "vite.config.ts").is_file():
        return beside_script
    discovered = find_app_dir(Path.cwd())
    if discovered:
        return discovered
    sys.exit("startdev: could not locate packages/app; pass --app-dir")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="startdev.py",
        description="Run the Vite dev server for packages/app against a running opencode backend.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The backend must already be listening (e.g. `bun dev serve --port 4098`).\n"
            "Open the printed http://localhost:<port> URL, not the backend port."
        ),
    )
    parser.add_argument("-p", "--port", type=int, default=4444, help="Vite dev server port (default: 4444)")
    parser.add_argument("-s", "--server-port", type=int, default=4096, help="backend opencode port (default: 4096)")
    parser.add_argument(
        "--server-host",
        default=os.environ.get("VITE_OPENCODE_SERVER_HOST", "localhost"),
        help="backend host (default: $VITE_OPENCODE_SERVER_HOST or localhost)",
    )
    parser.add_argument(
        "--channel",
        default=os.environ.get("OPENCODE_CHANNEL", "local"),
        choices=["local", "dev", "beta", "prod"],
        help="OPENCODE_CHANNEL for the build (default: local)",
    )
    parser.add_argument("--app-dir", default=None, help="path to packages/app (default: discovered)")
    parser.add_argument("--dry-run", action="store_true", help="print the resolved command without running it")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    app_dir = resolve_app_dir(args.app_dir)

    bun = shutil.which("bun")
    if not bun:
        sys.exit("startdev: bun not found on PATH")

    env = os.environ.copy()
    env["VITE_OPENCODE_SERVER_PORT"] = str(args.server_port)
    env["VITE_OPENCODE_SERVER_HOST"] = args.server_host
    env["OPENCODE_CHANNEL"] = args.channel

    command = [bun, "dev", "--", "--port", str(args.port)]
    print(f"startdev: app  {app_dir}")
    print(f"startdev: dev server -> http://localhost:{args.port}")
    print(f"startdev: backend    -> http://{args.server_host}:{args.server_port}")
    print(f"startdev: command    {' '.join(command)}")

    if args.dry_run:
        return 0

    try:
        return subprocess.run(command, cwd=app_dir, env=env).returncode
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
