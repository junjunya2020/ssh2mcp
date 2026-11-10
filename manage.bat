@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 纯透传：无参 -> 进入 TS 交互菜单；带参 -> 原样透传给 node CLI
if not exist "dist\main.js" (
  call npm run build
  if errorlevel 1 ( echo [X] 构建失败 & pause & exit /b 1 )
)

if "%~1"=="" (
  node dist\main.js menu
  pause
) else (
  node dist\main.js %*
  exit /b %errorlevel%
)
