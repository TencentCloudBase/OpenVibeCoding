@echo off
REM ========================================
REM  Project Initialization Script (Windows)
REM  Equivalent of init.sh for Windows users
REM ========================================

setlocal enabledelayedexpansion

echo.
echo ===============================================
echo      Project Initialization Script (Windows)
echo ===============================================

REM ---- Check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo Please install Node.js 18 or later: https://nodejs.org/
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo Node.js version: %NODE_VER%

REM ---- Check pnpm ----
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [WARN] pnpm is not installed. Trying to install via corepack...
    where corepack >nul 2>nul
    if errorlevel 1 (
        echo Installing pnpm via npm...
        call npm install -g pnpm
        if errorlevel 1 (
            echo [ERROR] Failed to install pnpm. Please run: npm install -g pnpm
            exit /b 1
        )
    ) else (
        call corepack enable
        call corepack prepare pnpm@latest --activate
    )
)

for /f "tokens=*" %%i in ('pnpm -v') do set PNPM_VER=%%i
echo pnpm version: %PNPM_VER%

REM ---- Run main initialization ----
echo.
echo Running initialization...
node scripts/init.mjs %*
