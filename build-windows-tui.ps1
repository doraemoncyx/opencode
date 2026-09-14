# Build Windows opencode CLI/TUI (single platform, win32-x64)
# Usage: .\build-windows-tui.ps1
#
# Deps are installed once at the repo root. The actual `bun run build` is
# invoked with `--single --skip-install`:
#   --single        only bundle the current platform/arch (win32-x64), so the
#                   build only targets the host instead of every OS/arch.
#   --skip-install  skip build.ts's `bun install --os="*" --cpu="*"` cross-platform
#                   re-fetch, which hits a Windows cache-move EPERM when re-extracting
#                   the `@opencode-ai/client` file: tarball; deps are already installed
#                   by `bun install` above.
$ErrorActionPreference = "Stop"
$script:dir = Split-Path $PSCommandPath -Parent

bun install

Push-Location "$script:dir\packages\cli"

try {
  Write-Host "Building: bun run build --single --skip-install" -ForegroundColor Cyan
  bun run build -- --single --skip-install
  if ($LASTEXITCODE -ne 0) { throw "Build failed (exit code $LASTEXITCODE)" }
  Write-Host "Build complete. Output in: packages\cli\dist\cli-windows-x64\bin\" -ForegroundColor Green
} finally {
  Pop-Location
  # 构建可能改写 bun.lock 与 package.json，这里还原以保持工作区干净
  git restore -- bun.lock packages/cli/package.json
}
