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
  echo 启动 Electron 桌面版...
  start "" "desktop\node_modules\electron\dist\electron.exe" "desktop\electron-main.cjs"
  exit /b 0
)

echo 启动本地服务（未安装 Electron，使用 Chrome 窗口模式；可运行 install-desktop.cmd 安装 Electron）...
start "Arknights Spine Studio - Server" node desktop\server.mjs

echo 等待服务就绪...
node desktop\wait-ready.mjs
if errorlevel 1 (
  echo [错误] 本地服务启动失败，请查看上面的服务窗口日志。
  pause
  exit /b 1
)

if /i "%~1"=="--no-browser" (
  echo 服务已就绪: http://127.0.0.1:4879/ui/
  exit /b 0
)

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://127.0.0.1:4879/ui/ --window-size=1280,860
) else (
  start "" http://127.0.0.1:4879/ui/
)
exit /b 0