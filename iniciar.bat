@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KekeClipper
where node >nul 2>nul || (echo Necesitas Node.js: winget install OpenJS.NodeJS.LTS & pause & exit /b)
if not exist node_modules (
  echo Instalando dependencias por unica vez...
  call npm install --no-fund --no-audit
)
node server.js
pause
