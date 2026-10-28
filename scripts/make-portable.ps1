# scripts/make-portable.ps1 — Build a portable ZIP package for team distribution.
# Usage:  pwsh -File scripts/make-portable.ps1
# Output: dist/问卷数字化工具-便携版-<date>.zip
#
# Why portable: zero budget + members must not install anything. We ship
# node.exe (MIT licensed, redistributable) next to the project. All runtime
# deps are pure JS (no native binaries), so node_modules is copy-portable
# across Windows x64 machines.

param([string]$NodeZip = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ver = (& node -v).TrimStart('v')          # match the running Node version
$dist = Join-Path $root 'dist'
$pkgName = '问卷数字化工具-便携版'
$pkg = Join-Path $dist (Join-Path 'build' $pkgName)

# 0. clean previous build
if (Test-Path (Join-Path $dist 'build')) { Remove-Item (Join-Path $dist 'build') -Recurse -Force }
New-Item $pkg -ItemType Directory -Force | Out-Null

# 1. node.exe — download once, cache in TEMP, reuse on rebuilds
$zipPath = if ($NodeZip) { $NodeZip } else { Join-Path $env:TEMP "node-$ver-win-x64.zip" }
if (-not (Test-Path $zipPath)) {
  $url = "https://npmmirror.com/mirrors/node/v$ver/node-v$ver-win-x64.zip"
  Write-Host "downloading portable node $ver ..."
  Invoke-WebRequest $url -OutFile $zipPath
}
Expand-Archive $zipPath -DestinationPath (Join-Path $dist 'build\_node') -Force
Copy-Item (Join-Path $dist "build\_node\node-v$ver-win-x64\node.exe") $pkg
Remove-Item (Join-Path $dist 'build\_node') -Recurse -Force

# 2. project files (code + docs + config)
foreach ($d in 'src', 'public', 'scripts', 'docs') {
  Copy-Item (Join-Path $root $d) (Join-Path $pkg $d) -Recurse
}
foreach ($f in 'package.json', 'README.md', '.env.example') {
  if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $pkg }
}
# .env 不进包：密钥只留在组长自己电脑里，组员首次使用在网页 ⚙ 设置里填自己的密钥

# 3. data dir: personal data must NOT leak into the package; keep qes examples
New-Item (Join-Path $pkg 'data\qes') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $root 'data\qes\example.qes') (Join-Path $pkg 'data\qes')

# 3b. 默认问卷结构（档案制）：放进 data/profiles/default/，组员解压即可识别。
# 便携版没有 settings.json → 服务器默认用档案 default；结构/元数据取当前生效档案。
$activeId = 'default'
try {
  $sCfg = Get-Content (Join-Path $root 'data\settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($sCfg.active) { $activeId = $sCfg.active }
} catch { }
$activeDir = Join-Path $root "data\profiles\$activeId"
$profDef = Join-Path $pkg 'data\profiles\default'
New-Item $profDef -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $activeDir 'survey.json') (Join-Path $profDef 'survey.json')
if (Test-Path (Join-Path $activeDir 'survey-checklist.md')) { Copy-Item (Join-Path $activeDir 'survey-checklist.md') $profDef }
try {
  $meta = Get-Content (Join-Path $activeDir 'profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  @{ name = $meta.name; pagesPerForm = $meta.pagesPerForm; idVariable = $meta.idVariable } |
    ConvertTo-Json | Set-Content (Join-Path $profDef 'profile.json') -Encoding UTF8
} catch { }   # 没有元数据就留空，服务器用默认值

# 4. runtime deps
Copy-Item (Join-Path $root 'node_modules') (Join-Path $pkg 'node_modules') -Recurse

# 5. usage note + launcher
Copy-Item (Join-Path $PSScriptRoot '便携版使用须知.txt') $pkg
Copy-Item (Join-Path $root '启动问卷工具.bat') $pkg

# 6. zip
$outZip = Join-Path $dist "$pkgName-$(Get-Date -Format yyyyMMdd).zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path $pkg -DestinationPath $outZip
$size = '{0:N0} MB' -f ((Get-Item $outZip).Length / 1MB)
Write-Host "done: $outZip ($size)"