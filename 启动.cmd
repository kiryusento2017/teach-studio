@echo off
chcp 65001 >nul
title PDF 转 Word · 云端版（开发模式）
cd /d "%~dp0"

rem 三样缺一不可：Python 环境、Electron、pandoc。
rem 缺了就直说缺什么、怎么补，不要让人对着一个闪退的黑框猜。

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   没找到 Python 运行环境（.venv）。先建一个：
  echo.
  echo     py -3.12 -m venv .venv
  echo     .venv\Scripts\python.exe -m pip install pymupdf lxml fastapi uvicorn python-docx requests
  echo.
  pause
  exit /b 1
)

if not exist "app\node_modules\electron\dist\electron.exe" (
  echo   正在装界面组件，第一次会慢一点...
  pushd app
  call npm install --no-audit --no-fund
  popd
)

if not exist "runtime\pandoc\pandoc.exe" (
  echo.
  echo   缺 runtime\pandoc\pandoc.exe —— 没有它一份都转不出来。
  echo   它有 222 MB，不在 git 里（GitHub 单文件上限 100 MB），
  echo   从别的地方拷一份过来。
  echo.
  pause
  exit /b 1
)

if not exist "runtime\xsl\MML2OMML.XSL" (
  echo   警告：缺 runtime\xsl\MML2OMML.XSL，
  echo   公式会退回 pandoc 那条次等路径，不是 Word 原生公式。
  echo.
)

pushd app
node_modules\electron\dist\electron.exe .
popd
