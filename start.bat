@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TASK_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "TASK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist ".tools\node_modules\npm\bin\npm-cli.js" (
  if not exist "node_modules\vite" "%TASK_NODE%" ".tools\node_modules\npm\bin\npm-cli.js" install
  "%TASK_NODE%" ".tools\node_modules\npm\bin\npm-cli.js" start
) else (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo 请先安装 Node.js 24 LTS（包含 npm），然后重新运行。
    pause
    exit /b 1
  )
  if not exist "node_modules\vite" call npm install
  call npm start
)
pause
