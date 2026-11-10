# 以管理员身份运行：把 sshmcp 注册为 Windows 服务（通过 WinSW）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "dist\main.js")) {
  Write-Host "[!] 未找到 dist\main.js，先构建：npm install; npm run build"
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "[!] 需要管理员权限"; exit 1 }

$gen = Join-Path $root "service\generated"
New-Item -ItemType Directory -Force -Path $gen | Out-Null

# 1) 让程序生成 sshmcp.xml（含当前 node 路径/数据目录/token）
node dist\main.js service install | Out-Null
$xml = Join-Path $gen "sshmcp.xml"
if (-not (Test-Path $xml)) { Write-Host "[!] 未生成 $xml"; exit 1 }

# 2) 下载 WinSW（若不存在）
$winswExe = Join-Path $gen "sshmcp-service.exe"
if (-not (Test-Path $winswExe)) {
  Write-Host "[*] 下载 WinSW..."
  $url = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
  Invoke-WebRequest -Uri $url -OutFile $winswExe
}

# 3) WinSW 要求 xml 与 exe 同名
Copy-Item $xml (Join-Path $gen "sshmcp-service.xml") -Force

# 4) 安装 / 启动
Push-Location $gen
try {
  & .\sshmcp-service.exe stop    2>$null | Out-Null
  & .\sshmcp-service.exe uninstall 2>$null | Out-Null
  & .\sshmcp-service.exe install
  & .\sshmcp-service.exe start
} finally { Pop-Location }

Write-Host "`n[✓] 服务已安装并启动。"
sc.exe query sshmcp
Write-Host "`n客户端 MCP 配置 (http):"
node dist\main.js config
