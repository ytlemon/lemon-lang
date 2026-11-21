<#
.SYNOPSIS
  把 GitHub 个人访问令牌（PAT）存进 Windows 凭据管理器，只填这一次。

.DESCRIPTION
  利用系统里已装好的 Git Credential Manager（credential.helper = manager），
  把令牌交给 `git credential approve`，由它写进 Windows 凭据管理器。
  之后 git push / pull / clone 访问 https://github.com 都会自动取用，不再询问。

  令牌只在内存里出现，不写进任何文件、不进 git、不打印到屏幕。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-github-token.ps1

.EXAMPLE
  # 只检查当前是否已存过凭据（不提示输入）
  powershell -ExecutionPolicy Bypass -File scripts\setup-github-token.ps1 -CheckOnly
#>
param(
  [string]$Username = 'ytlemon',
  [string]$GitHost = 'github.com',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

# ---- 1. 环境检查（只读） ----
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw '找不到 git，请先安装 Git for Windows。'
}

$helpers = @(git config --get-all credential.helper)
if ($helpers.Count -eq 0) {
  throw '没有配置 credential.helper。Git for Windows 默认是 manager（GCM）；请装上 Git Credential Manager 后重试。'
}
Write-Host "凭据助手：$($helpers -join ', ')"

if ($CheckOnly) {
  # 不回显 password 字段：只确认"有没有存过"
  $lines = @("protocol=https`nhost=$GitHost`n`n" | git credential fill)
  if ($LASTEXITCODE -ne 0) { throw '读取凭据失败。' }
  $hasCredential = ($lines -join "`n") -match '(?m)^password=.+'
  if ($hasCredential) {
    Write-Host "已存有 $Username@$GitHost 的凭据。"
  } else {
    Write-Host "还没有存 $GitHost 的凭据。去掉 -CheckOnly 运行本脚本填一次。"
  }
  exit 0
}

# ---- 2. 只提示这一次 ----
$secure = Read-Host "GitHub 令牌（只需填这一次；不会显示、不会存成文件）" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($plain)) { throw '令牌为空，未保存。' }

# ---- 3. 交给 GCM 存进 Windows 凭据管理器 ----
$payload = "protocol=https`nhost=$GitHost`nusername=$Username`npassword=$plain`n"
$payload | git credential approve | Out-Null
if ($LASTEXITCODE -ne 0) { throw '保存失败：git credential approve 返回非 0。' }

# ---- 4. 验证读取（依然不回显令牌） ----
$check = @("protocol=https`nhost=$GitHost`n`n" | git credential fill)
if ($LASTEXITCODE -ne 0) { throw '保存后回读失败。' }
if (($check -join "`n") -notmatch '(?m)^password=.+') { throw '没有读到刚保存的凭据。' }

Write-Host "完成：$Username@$GitHost 的令牌已交给 $($helpers -join ', ')，以后 git 不再询问。"
Write-Host '可在“凭据管理器 → Windows 凭据 → 通用凭据”里看到 git:https://github.com 一项。'
