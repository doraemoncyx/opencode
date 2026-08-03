# Build Windows opencode TUI only
# Usage: .\build-windows-tui.ps1
#   -skipInstall: skip bun install (faster if deps already installed)
#   -baseline: build baseline (non-AVX2) binary
param(
  [switch]$skipInstall,
  [switch]$baseline
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
}
