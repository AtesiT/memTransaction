@echo off
rem ============================================================================
rem  TmLab: build an Android APK file (no device needed).
rem  The APK is created in TmLab\bin\Debug\net10.0-android\TmLab.apk -
rem  copy it to a phone (USB, messenger, cloud) and install it there.
rem  On the phone allow installs from unknown sources for the app you use
rem  to open the file (browser, file manager, messenger).
rem
rem  Usage: double-click this file, or run it from the command line:
rem      C:\...\memTransaction\maui\build-android-apk.cmd
rem
rem  This builds a DEBUG apk signed with the debug key - it installs on
rem  any phone. A release build would need a signing keystore.
rem
rem  How it works: the project builds only the Windows target by default
rem  (WindowsOnly=true in TmLab.csproj). Setting WindowsOnly=false here adds
rem  the Android target; "-f net10.0-android" builds only Android.
rem
rem  (This file is ASCII-only on purpose: cmd.exe mangles Cyrillic text.)
rem ============================================================================

setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%TmLab" || (echo [ERROR] Project folder not found: %ROOT%TmLab & exit /b 1)

set "WindowsOnly=false"

echo ==== build APK ====
echo (first run restores packages - needs access to nuget.org)
call dotnet build -f net10.0-android -c Debug
if errorlevel 1 goto failed

set "APK=bin\Debug\net10.0-android\TmLab.apk"
if not exist "%APK%" (
  echo [ERROR] APK not found: %APK%
  echo APK files in bin:
  dir /s /b "bin\*.apk"
  exit /b 1
)

echo.
echo ============================ APK READY ============================
echo.
echo File: %ROOT%TmLab\%APK%
echo.
echo Copy this file to the phone and install it.
echo On the phone, allow installs from unknown sources for the app
echo you use to open the file (browser, file manager, messenger).
echo.
echo Opening the folder with the APK...
start "" "%ROOT%TmLab\bin\Debug\net10.0-android"
exit /b 0

:failed
echo.
echo ============================ BUILD FAILED ============================
echo.
echo If the error mentions a missing SDK or workload, check
echo "dotnet workload list" - the "android" workload and the
echo Android SDK must be installed.
exit /b 1
