@echo off
setlocal
if exist "%~dp0..\..\..\..\node.exe" (
  "%~dp0..\..\..\..\node.exe" "%~dp0skyalyticwing.cjs" %*
) else (
  node "%~dp0skyalyticwing.cjs" %*
)
exit /b %errorlevel%
