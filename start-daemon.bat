@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 纯透传：前台启动守护进程，日志实时打印；Ctrl+C 停止
rem 可选参数1：端口（默认 8765）  例：start-daemon.bat 8899

if not exist "node_modules" (
  echo [*] 首次运行，安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [X] npm install 失败 & pause & exit /b 1 )
)
if not exist "dist\main.js" (
  call npm run build
  if errorlevel 1 ( echo [X] 构建失败 & pause & exit /b 1 )
)

set "PORT=8765"
if not "%~1"=="" set "PORT=%~1"

echo ============================================================
echo   sshmcp daemon  前台守护进程（日志实时打印）
echo   端口: %PORT%    停止: Ctrl+C
echo ============================================================

node dist\main.js daemon --foreground --port %PORT%

echo.
echo [daemon 已退出] 退出码=%errorlevel%
pause
