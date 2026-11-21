<#
  Lemon 一键安装（在目标电脑上运行，双击同目录的「安装.bat」）

  做四件事，全部只影响当前用户，不需要管理员：
    1. 把 lemon.exe 放到 %LOCALAPPDATA%\Programs\Lemon\
    2. 把该目录加进「用户 PATH」（不动系统 PATH，也不做危险的整串覆盖）
    3. 找到编辑器的命令行入口，装上 lemon-language.vsix
    4. 把解释器路径写进编辑器设置 lemon.executablePath

  第 3 步最麻烦：编辑器不一定装在默认位置，命令行也不一定在 PATH 上。
  这里按「PATH → 正在运行的进程 → 开始菜单快捷方式」三层去找，
  三层都找不到就把 vsix 放着并打印手动安装步骤，绝不让脚本半路静默失败。
#>

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$exeSrc = Join-Path $here 'lemon.exe'
$vsixSrc = Join-Path $here 'lemon-language.vsix'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Lemon'
$exeDest = Join-Path $installDir 'lemon.exe'

function Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "   [完成] $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "   [注意] $text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0. 自检

Step '0/4  检查安装包'

$missing = @()
if (-not (Test-Path $exeSrc)) { $missing += 'lemon.exe' }
if (-not (Test-Path $vsixSrc)) { $missing += 'lemon-language.vsix' }
if ($missing.Count -gt 0) {
  Warn ('缺少文件：' + ($missing -join '、'))
  Warn '请把整个「Lemon 安装包」文件夹一起复制过来，不要只拷其中的某一个文件。'
  exit 1
}
Ok "解释器 $( '{0:N1} MB' -f ((Get-Item $exeSrc).Length / 1MB) )，扩展 $( '{0:N1} KB' -f ((Get-Item $vsixSrc).Length / 1KB) )"

# ------------------------------------------------- 1. 放解释器

Step '1/4  安装解释器'

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force $exeSrc $exeDest
Ok "lemon.exe -> $exeDest"

# ------------------------------------------------- 2. 加进用户 PATH

Step '2/4  加入用户 PATH'

# 逐段读写并去重，不用 setx —— setx 在路径超过 1024 字符时会静默截断，
# 把用户的 PATH 弄坏是很难查的事故。
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ([string]::IsNullOrEmpty($userPath)) { $userPath = '' }
$segments = @($userPath -split ';' | Where-Object { $_ -ne '' })

if ($segments -contains $installDir) {
  Ok '已经在 PATH 里了，跳过'
} else {
  $merged = (@($segments) + $installDir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $merged, 'User')
  Ok "已追加 $installDir"
  Warn '新开的终端才会生效（已经开着的窗口读的是旧 PATH）'
}

# ------------------------------------------------- 3. 装扩展

Step '3/4  安装编辑器扩展'

function Find-IdeCli {
  # 第一层：命令行就在 PATH 上
  foreach ($name in 'buddycn', 'code', 'codebuddy', 'code-insiders', 'codium') {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
  }

  # 第二层：编辑器正在运行 —— 从进程路径反推安装目录。
  # 装在任何盘任何目录都找得到，是这三层里最可靠的一层。
  foreach ($pattern in 'CodeBuddy*', 'Code', 'VSCodium', 'Cursor') {
    $proc = Get-Process -Name $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $proc -or [string]::IsNullOrEmpty($proc.Path)) { continue }
    $bin = Join-Path (Split-Path $proc.Path) 'bin'
    if (-not (Test-Path $bin)) { continue }
    $cmd = Get-ChildItem $bin -Filter '*.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.FullName }
  }

  # 第三层：开始菜单快捷方式指向哪
  $shell = New-Object -ComObject WScript.Shell
  $roots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $links = Get-ChildItem $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'CodeBuddy|Code|Cursor' }
    foreach ($link in $links) {
      $target = $shell.CreateShortcut($link.FullName).TargetPath
      if ([string]::IsNullOrEmpty($target)) { continue }
      $bin = Join-Path (Split-Path $target) 'bin'
      if (-not (Test-Path $bin)) { continue }
      $cmd = Get-ChildItem $bin -Filter '*.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($cmd) { return $cmd.FullName }
    }
  }

  return $null
}

$ideCli = Find-IdeCli
$extensionInstalled = $false

if ($null -eq $ideCli) {
  Warn '没找到编辑器的命令行入口，扩展没有自动安装。'
  Write-Host ''
  Write-Host '   手动装（一次就够）：' -ForegroundColor Yellow
  Write-Host '     1) 打开编辑器 → 左侧「扩展」面板'
  Write-Host '     2) 点面板右上角的「...」→「从 VSIX 安装...」'
  Write-Host "     3) 选中：$vsixSrc"
  Write-Host '     4) 装完重启编辑器'
} else {
  Ok "命令行入口：$ideCli"
  & $ideCli --install-extension $vsixSrc --force
  if ($LASTEXITCODE -eq 0) {
    $extensionInstalled = $true
    Ok 'lemon-language 扩展已安装'
  } else {
    Warn "安装命令返回了 $LASTEXITCODE，请按上面的手动步骤再试一次"
  }
}

# ------------------------------------------------- 4. 写编辑器设置

Step '4/4  告诉扩展解释器在哪'

# 为什么还要写设置：PATH 是刚改的，编辑器进程继承的是启动时的旧环境，
# 光靠 PATH 得等重启才认。写死路径可以让它立刻就能用。
$settingsFile = $null
$productDirs = @(Get-ChildItem $env:APPDATA -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'User\settings.json') })

if ($productDirs.Count -eq 1) {
  $settingsFile = Join-Path $productDirs[0].FullName 'User\settings.json'
} elseif ($productDirs.Count -gt 1) {
  # 多个编辑器都装着：优先名字里带 Code/Buddy 的那个
  $preferred = $productDirs | Where-Object { $_.Name -match 'Code|Buddy' } | Select-Object -First 1
  if ($preferred) { $settingsFile = Join-Path $preferred.FullName 'User\settings.json' }
}

if ($null -eq $settingsFile) {
  Warn '没定位到编辑器设置文件，跳过这一步（不影响使用：重启后扩展会从 PATH 找到 lemon）'
} elseif ((Get-Content $settingsFile -Raw -ErrorAction SilentlyContinue) -match '"lemon\.executablePath"') {
  Ok '设置里已经有 lemon.executablePath，跳过'
} else {
  $raw = Get-Content $settingsFile -Raw
  $pathForJson = $exeDest.Replace('\', '\\')
  $entry = "`n    `"lemon.executablePath`": `"$pathForJson`","

  if ([string]::IsNullOrWhiteSpace($raw)) {
    $newRaw = "{`n    `"lemon.executablePath`": `"$pathForJson`"`n}`n"
  } else {
    # 只在第一个 { 后面插一行：settings.json 允许注释，用 JSON 解析会失败，
    # 硬解析再写回会把用户的注释全丢掉。字符串插行最安全。
    $brace = $raw.IndexOf('{')
    if ($brace -lt 0) { $brace = -1 }
    $newRaw = $raw.Substring(0, $brace + 1) + $entry + $raw.Substring($brace + 1)
  }

  # 不带 BOM 写回：VS Code 自己的默认写法，避免某些版本把 BOM 显示成乱码
  [System.IO.File]::WriteAllText($settingsFile, $newRaw, (New-Object System.Text.UTF8Encoding($false)))
  Ok "已写入 $settingsFile"
}

# ---------------------------------------------------------------- 收尾

Step '安装完成'

Write-Host "   解释器：$exeDest"
if ($extensionInstalled) { Write-Host '   扩展：  lemon-language（已通过命令行安装）' }
Write-Host ''
Write-Host '   接下来请做两件事：' -ForegroundColor Cyan
Write-Host '     1) 重启编辑器 —— 语言注册、扩展、图标都是启动时读一次'
Write-Host '     2) 新开一个终端窗口（旧窗口读的是老 PATH），验证：'
Write-Host ''
Write-Host '        lemon --version' -ForegroundColor White
Write-Host '        lemon examples\hello.lemon1' -ForegroundColor White
Write-Host ''
Write-Host '   编辑器里打开任意 .lemon1 文件，右上角会出现「▶ 运行」按钮。' -ForegroundColor Cyan
Write-Host ''
