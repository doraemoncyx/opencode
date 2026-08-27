# Build Windows opencode TUI
# Usage: .\build-windows-tui.ps1
#   -skipInstall: skip bun install (faster if deps already installed)
#   -baseline: build baseline (non-AVX2) binary
#   -desktop: also build the Electron desktop app (NSIS installer)
#   -channel: desktop release channel: dev | beta | prod (default: prod)
#     prod/beta skip the dev-only CLI download step, which requires a
#     published @opencode-ai/cli-* version that may not exist yet.
param(
  [switch]$skipInstall,
  [switch]$baseline,
  [switch]$desktop,
  [ValidateSet("dev", "beta", "prod")]
  [string]$channel = "prod"
)

bun install
$ErrorActionPreference = "Stop"
$script:dir = Split-Path $PSCommandPath -Parent

Push-Location "$script:dir\packages\opencode"

try {
  $flags = @("--single")
  if ($skipInstall) { $flags += "--skip-install" }
  if ($baseline)    { $flags += "--baseline" }

  Write-Host "Building: bun run build -- $($flags -join ' ')" -ForegroundColor Cyan
  bun run build -- @flags

  if ($LASTEXITCODE -ne 0) { throw "Build failed (exit code $LASTEXITCODE)" }

  Write-Host "Build complete. Output in: packages\opencode\dist\" -ForegroundColor Green
} finally {
  Pop-Location
  # 构建可能改写 bun.lock 与 package.json，这里还原以保持工作区干净
  git restore -- bun.lock packages/opencode/package.json
}

if ($desktop) {
  Write-Host "Building desktop app (channel: $channel)..." -ForegroundColor Cyan
  Push-Location "$script:dir\packages\desktop"

  try {
    $env:OPENCODE_CHANNEL = $channel
    bun run build
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed (exit code $LASTEXITCODE)" }

    bun run package:win
    if ($LASTEXITCODE -ne 0) { throw "Desktop package failed (exit code $LASTEXITCODE)" }

    Write-Host "Desktop build complete. Output in: packages\desktop\dist\" -ForegroundColor Green
  } finally {
    Pop-Location
    Remove-Item Env:OPENCODE_CHANNEL -ErrorAction SilentlyContinue
  }
}
