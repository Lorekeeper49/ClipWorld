@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Packages ClipWorld for a GitHub release into release\v<version>\ :
rem   ClipWorld-Setup-<version>-x64.exe       Windows installer
rem   ClipWorld-<version>-win-x64.zip         Windows portable (unzip and run ClipWorld.exe)
rem   ClipWorld-<version>-linux-x64.tar.gz    Linux x64 (extract and run ./clipworld)
rem   SHA256SUMS.txt                          checksums of the files above
rem
rem   release.bat            build the files
rem   release.bat arm64      also build ClipWorld-<version>-linux-arm64.tar.gz
rem   release.bat publish    build, then create a DRAFT GitHub release v<version> with the files and
rem                          release-notes\v<version>.md (needs the GitHub CLI "gh", logged in; you publish
rem                          the draft yourself on GitHub after checking it)
rem   release.bat notest     skip the automated tests
rem Options can be combined, e.g.  release.bat arm64 publish
rem The version comes from package.json.

set "ARM64=0"
set "PUBLISH=0"
set "NOTEST=0"
for %%A in (%*) do (
  if /I "%%~A"=="arm64" set "ARM64=1"
  if /I "%%~A"=="publish" set "PUBLISH=1"
  if /I "%%~A"=="notest" set "NOTEST=1"
)

where node >nul 2>nul || ( echo Node.js was not found. Install it from https://nodejs.org and run this again. & goto :fail )

tasklist /FI "IMAGENAME eq ClipWorld.exe" 2>nul | find /I "ClipWorld.exe" >nul
if not errorlevel 1 ( echo ClipWorld is running. Close it first, then run this again. & goto :fail )

for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "VERSION=%%V"
if "%VERSION%"=="" ( echo Could not read the version from package.json. & goto :fail )
set "TAG=v%VERSION%"
set "OUT=release\%TAG%"
set "NOTES=release-notes\%TAG%.md"
echo === ClipWorld %VERSION% ===

rem ---- checks for publishing, done first so a long build is not wasted
if "%PUBLISH%"=="1" (
  where gh >nul 2>nul || ( echo The GitHub CLI "gh" was not found: https://cli.github.com & goto :fail )
  gh auth status >nul 2>nul || ( echo gh is not logged in. Run: gh auth login & goto :fail )
  if not exist "%NOTES%" ( echo Release notes not found: %NOTES% & goto :fail )
  for /f "delims=" %%S in ('git status --porcelain') do ( echo There are uncommitted changes. Commit them first so the release matches the code. & goto :fail )
  git fetch --quiet origin
  set "PUSHED="
  for /f "delims=" %%B in ('git branch -r --contains HEAD') do set "PUSHED=1"
  if not defined PUSHED ( echo This commit has not been pushed to GitHub. Run "git push" first. & goto :fail )
  gh release view %TAG% >nul 2>nul && ( echo A GitHub release %TAG% already exists. Bump "version" in package.json first. & goto :fail )
)

if not exist node_modules (
  echo === Installing dependencies ===
  call npm install --no-fund --no-audit || goto :fail
)

echo === Downloading ffmpeg (skipped when already present) ===
call node scripts\fetch-ffmpeg.mjs --platform win32 --arch x64 || goto :fail
call node scripts\fetch-ffmpeg.mjs --platform linux --arch x64 || goto :fail
if "%ARM64%"=="1" ( call node scripts\fetch-ffmpeg.mjs --platform linux --arch arm64 || goto :fail )

echo === Type-checking ===
call npm run typecheck || goto :fail
if "%NOTEST%"=="0" (
  echo === Running tests ===
  call npm test || goto :fail
)

echo === Checking nothing has the last build open ===
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-unlocked.ps1 dist\win-unpacked dist\linux-unpacked dist\linux-arm64-unpacked || goto :fail

echo === Bundling ===
call npx electron-vite build || goto :fail

echo === Windows installer and portable zip ===
call npx electron-builder --win nsis zip --x64 --publish never || goto :fail

echo === Linux x64 ===
if exist dist\linux-unpacked rmdir /s /q dist\linux-unpacked
call npx electron-builder --linux dir --x64 --publish never || goto :fail

if "%ARM64%"=="1" (
  echo === Linux arm64 ===
  if exist dist\linux-arm64-unpacked rmdir /s /q dist\linux-arm64-unpacked
  call npx electron-builder --linux dir --arm64 --publish never || goto :fail
)

echo === Collecting files in %OUT% ===
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" || goto :fail
copy /y "dist\ClipWorld-Setup-%VERSION%-x64.exe" "%OUT%\" >nul || goto :fail
copy /y "dist\ClipWorld-%VERSION%-win-x64.zip" "%OUT%\" >nul || goto :fail
rem Windows cannot store Linux file permissions, so the Linux archive is written with them set explicitly.
call node scripts\pack-linux-tar.mjs dist\linux-unpacked "%OUT%\ClipWorld-%VERSION%-linux-x64.tar.gz" "ClipWorld-%VERSION%-linux-x64" || goto :fail
if "%ARM64%"=="1" (
  call node scripts\pack-linux-tar.mjs dist\linux-arm64-unpacked "%OUT%\ClipWorld-%VERSION%-linux-arm64.tar.gz" "ClipWorld-%VERSION%-linux-arm64" || goto :fail
)
echo.
echo === SHA-256 checksums ===
call node scripts\checksums.mjs "%OUT%" || goto :fail

if "%PUBLISH%"=="1" (
  echo.
  echo === Creating a draft GitHub release %TAG% ===
  for /f "delims=" %%H in ('git rev-parse HEAD') do set "COMMIT=%%H"
  gh release create %TAG% "%OUT%\*" --draft --title "ClipWorld %VERSION%" --notes-file "%NOTES%" --target !COMMIT! || goto :fail
  echo.
  echo Draft created. Review it on GitHub and press "Publish release" when ready:
  gh release view %TAG% --web
)

echo.
echo Done. Release files are in %CD%\%OUT%
if "%PUBLISH%"=="0" (
  echo To upload them yourself, create a release for tag %TAG% on GitHub and attach every file in that folder,
  echo or run:  release.bat publish
)
explorer "%OUT%"
goto :end

:fail
echo.
echo Release build failed.
pause
endlocal & exit /b 1

:end
endlocal
