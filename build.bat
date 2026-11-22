@echo off
REM Copyright (C) 2026 Lorekeeper49
REM
REM This file is part of ClipWorld.
REM
REM ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
REM General Public License as published by the Free Software Foundation, either version 3 of the
REM License, or (at your option) any later version.
REM
REM ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
REM even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
REM General Public License for more details.
REM
REM You should have received a copy of the GNU General Public License along with ClipWorld. If not,
REM see <https://www.gnu.org/licenses/>.

setlocal
cd /d "%~dp0"

rem Builds ClipWorld into dist\win-unpacked\ClipWorld.exe and launches it.
rem   build.bat            build, then launch
rem   build.bat nolaunch   build only
rem   build.bat installer  build the Windows installer (dist\ClipWorld Setup x.y.z.exe) instead

set "MODE=%~1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  goto :fail
)

rem Anything holding the last build's files open (a running ClipWorld, an editor, OneDrive uploading it)
rem would make the build fail half way. Check first and say exactly which program it is.
if exist dist\win-unpacked (
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-unlocked.ps1 dist\win-unpacked
  if errorlevel 1 goto :fail
)

if not exist node_modules (
  echo === Installing dependencies ===
  call npm install --no-fund --no-audit
  if errorlevel 1 goto :fail
)

rem Downloads the pinned ffmpeg build when it is missing or the pin changed; otherwise does nothing.
echo === Checking ffmpeg ===
call npm run fetch-ffmpeg
if errorlevel 1 goto :fail

echo === Type-checking ===
call npm run typecheck
if errorlevel 1 goto :fail

if /I "%MODE%"=="installer" (
  echo === Building installer ===
  call npm run package
) else (
  echo === Building app ===
  call npm run package:dir
)
if errorlevel 1 goto :fail

echo.
if /I "%MODE%"=="installer" (
  echo Done. The installer is in the dist folder.
  explorer dist
  goto :end
)

echo Done: %CD%\dist\win-unpacked\ClipWorld.exe
if /I "%MODE%"=="nolaunch" goto :end
start "" "%CD%\dist\win-unpacked\ClipWorld.exe"
goto :end

:fail
echo.
echo Build failed.
if /I not "%MODE%"=="nolaunch" pause
endlocal & exit /b 1

:end
endlocal
