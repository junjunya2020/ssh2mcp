@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 一次性模式：临时、随机、免登录
rem  - 随机本地端口 + 随机 key（只在本窗口打印一次，不落盘）
rem  - 强制免登录临时 CF 隧道（每次新 URL）
rem  - 只持久化主机密钥（known_hosts），其余全临时
rem  - 退出即清理；不支持服务模式；必须前台

if not exist "node_modules" (
  echo [*] 首次运行，安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [X] npm install 失败 & pause & exit /b 1 )
)
if not exist "dist\main.js" (
  call npm run build
  if errorlevel 1 ( echo [X] 构建失败 & pause & exit /b 1 )
)

echo ============================================================
echo   sshmcp 一次性模式（临时端口 / 随机 key / 免登录隧道）
echo   停止: Ctrl+C   退出后不留任何凭据
echo ============================================================
echo.

node dist\main.js daemon --oneshot --foreground

echo.
echo [一次性 daemon 已退出并清理] 退出码=%errorlevel%
pause
