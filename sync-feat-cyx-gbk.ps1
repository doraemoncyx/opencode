param(
  [switch]$rebase,
  [switch]$merge
)

$ErrorActionPreference = "Stop"
# 保证 git 输出（UTF-8）能被 PowerShell 正确解码，避免中文提交信息被误当 GBK 产生乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:dir = Split-Path $PSCommandPath -Parent
Push-Location $script:dir

try {
  # 添加 upstream（首次）
  $upstream = git remote get-url upstream 2>$null
  if (-not $upstream) {
    git remote add upstream git@github.com:anomalyco/opencode.git
    Write-Host "Added upstream remote" -ForegroundColor Cyan
  }

  # 确保本地在 feat/dev0906
  $branch = git branch --show-current
  if ($branch -ne "feat/dev0906") {
    git checkout feat/dev0906
  }

  # 丢弃本地未提交修改
  git reset --hard
  Write-Host "Reset local changes" -ForegroundColor Cyan

  # 拉取最新
  Write-Host "Fetching upstream dev..." -ForegroundColor Cyan
  git fetch upstream dev

  if ($merge) {
    Write-Host "Merging upstream/dev..." -ForegroundColor Yellow
    git merge upstream/dev --no-edit
    Write-Host "Pushing to fork..." -ForegroundColor Cyan
    git push fork feat/dev0906
  } else {
    # 先把本地个人提交压缩成一条，让 rebase 只需重放 1 条（提交越多越慢的问题根源）
    Write-Host "Squashing local commits into one..." -ForegroundColor Yellow
    $ahead = git rev-list --count upstream/dev..feat/dev0906
    if ($ahead -gt 1) {
      git reset --soft upstream/dev
      git commit -m "feat(dev0906): fork 累积改动"
    }
    Write-Host "Rebasing onto upstream/dev..." -ForegroundColor Yellow
    git rebase upstream/dev
    if ($LASTEXITCODE -ne 0) {
      # 冲突时 rebase 会暂停在中间，交由用户手动解决，绝不继续 force push
      $gitDir = git rev-parse --git-dir
      if ((Test-Path (Join-Path $gitDir "rebase-merge")) -or (Test-Path (Join-Path $gitDir "rebase-apply"))) {
        Write-Host "Rebase 因冲突暂停：请手动解决冲突后运行 'git rebase --continue'，或运行 'git rebase --abort' 放弃本次同步。" -ForegroundColor Red
        exit 1
      }
      throw "git rebase 失败（退出码 $LASTEXITCODE）"
    }
    Write-Host "Force pushing to fork..." -ForegroundColor Cyan
    git push fork feat/dev0906 --force-with-lease
  }
} finally {
  Pop-Location
}
