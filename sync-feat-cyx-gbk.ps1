param(
  [switch]$rebase,
  [switch]$merge
)

$ErrorActionPreference = "Stop"
$script:dir = Split-Path $PSCommandPath -Parent
Push-Location $script:dir

try {
  # 添加 upstream（首次）
  $upstream = git remote get-url upstream 2>$null
  if (-not $upstream) {
    git remote add upstream git@github.com:anomalyco/opencode.git
    Write-Host "Added upstream remote" -ForegroundColor Cyan
  }

  # 确保本地在 feat/cyx_gbk
  $branch = git branch --show-current
  if ($branch -ne "feat/cyx_gbk") {
    git checkout feat/cyx_gbk
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
    git push fork feat/cyx_gbk
  } else {
    Write-Host "Squashing branch commits into one..." -ForegroundColor Yellow
    $mergeBase = git merge-base HEAD upstream/dev
    $head = git rev-parse HEAD
    if ($mergeBase -ne $head) {
      $msg = git log -1 --format=%s
      git reset --soft $mergeBase
      git commit -m $msg
    }
    Write-Host "Rebasing onto upstream/dev..." -ForegroundColor Yellow
    git rebase upstream/dev
    Write-Host "Force pushing to fork..." -ForegroundColor Cyan
    git push fork feat/cyx_gbk --force-with-lease
  }
} finally {
  Pop-Location
}
