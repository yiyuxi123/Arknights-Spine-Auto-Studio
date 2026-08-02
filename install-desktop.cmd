@echo off
chcp 936 >nul
cd /d "%~dp0"
rem --- prefer bundled portable node ---
set "NODE=%~dp0vendor\node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未找到 Node.js 运行时，无法安装 Electron。
    echo 请重新解压完整发布包（含 vendor\node\node.exe），或安装 Node.js v18+ 并加入 PATH。
    pause
    exit /b 1
  )
  set "NODE=node"
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [提示] 未找到 npm 命令（安装 Electron 需要 npm）。
  echo 没有 Electron 也能正常使用：直接双击 start-desktop.cmd 走 Chrome 模式即可。
  pause
  exit /b 0
)
if exist "desktop\node_modules\electron\dist\electron.exe" (
  echo Electron 已安装，直接运行 start-desktop.cmd 即可。
  pause
  exit /b 0
)
echo 正在安装 Electron（约 100MB，首次安装请耐心等待）...
cd desktop
call npm install --save-dev electron
if errorlevel 1 (
  echo 默认源安装失败，改用 npmmirror 镜像重试...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --save-dev electron --registry=https://registry.npmmirror.com
)
rem --- fallback: npm may skip postinstall, download Electron runtime manually ---
if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在从 npmmirror 镜像下载 Electron 运行时（约 100MB）...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  "%NODE%" node_modules\electron\install.js
)
cd ..
if exist "desktop\node_modules\electron\dist\electron.exe" (
  echo.
  echo OK: Electron 安装完成，双击 start-desktop.cmd 启动桌面版。
) else (
  echo.
  echo Electron 安装失败，可直接双击 start-desktop.cmd 使用 Chrome 模式。
)
pause
