@echo off
chcp 936 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js v18+ 并加入 PATH。
  pause
  exit /b 1
)
if exist "desktop\node_modules\electron\dist\electron.exe" (
  echo Electron 已安装，直接运行 start-desktop.cmd 即可。
  pause
  exit /b 0
)
echo 正在安装 Electron（约 100MB，首次较慢，请耐心等待）...
cd desktop
call npm install --save-dev electron
if errorlevel 1 (
  echo 默认源安装失败，改用 npmmirror 镜像重试...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --save-dev electron --registry=https://registry.npmmirror.com
)
cd ..
if exist "desktop\node_modules\electron\dist\electron.exe" (
  echo.
  echo OK: Electron 安装完成，双击 start-desktop.cmd 启动桌面版。
) else (
  echo.
  echo Electron 安装失败，仍可双击 start-desktop.cmd 使用 Chrome 窗口模式。
)
pause