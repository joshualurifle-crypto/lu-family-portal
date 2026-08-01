@echo off
title Lu Family Game Portal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org  ^(LTS^), then run this again.
  pause
  exit /b
)
node lu_family_portal.js
pause
