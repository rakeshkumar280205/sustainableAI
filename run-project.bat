@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo [sustainableAI] Checking dependencies...
if not exist package-lock.json (
    echo [sustainableAI] package-lock.json not found. Run this script from the project root.
    exit /b 1
)

if not exist node_modules (
    echo [sustainableAI] node_modules not found. Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [sustainableAI] npm install failed.
        exit /b 1
    )
)

if not exist .env (
    echo [sustainableAI] .env not found. Copy .env.example to .env and configure OPENROUTER_API_KEY.
    exit /b 1
)

findstr /R /B /C:"OPENROUTER_API_KEY=." .env >nul
if errorlevel 1 (
    echo [sustainableAI] OPENROUTER_API_KEY is not configured in .env.
    exit /b 1
)

set "API_PORT=3000"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$connections = @(Get-NetTCPConnection -LocalPort %API_PORT% -State Listen -ErrorAction SilentlyContinue); foreach ($connection in $connections) { $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue; if ($process.ProcessName -eq 'node') { Write-Host ('[sustainableAI] Stopping existing Node process on port %API_PORT% (PID ' + $process.Id + ')...'); Stop-Process -Id $process.Id -Force } else { Write-Error ('Port %API_PORT% is in use by ' + $process.ProcessName + ' (PID ' + $process.Id + ').'); exit 1 } }"
if errorlevel 1 (
    echo [sustainableAI] Could not free port %API_PORT%.
    exit /b 1
)
ping 127.0.0.1 -n 2 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %API_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
    echo [sustainableAI] Port %API_PORT% is still in use.
    exit /b 1
)

echo [sustainableAI] Starting OpenRouter-first frontend and API...
call npm run dev

endlocal
