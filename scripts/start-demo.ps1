param(
    [string]$DatabasePath = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $root '.venv/Scripts/python.exe'
$frontend = Join-Path $root 'frontend'
$logDir = Join-Path $root 'backend/data'

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js и npm не найдены. Установите Node.js и запустите скрипт снова.'
}
if (-not (Test-Path -LiteralPath $python)) {
    $existing = Join-Path $root 'participant_package/.venv/Scripts/python.exe'
    if (Test-Path -LiteralPath $existing) {
        $python = $existing
    } else {
        if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
            throw 'Python не найден. Установите Python и запустите скрипт снова.'
        }
        python -m venv (Join-Path $root '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать Python-окружение.' }
    }
}

& $python -c 'import fastapi, uvicorn, pandas, numpy, httpx'
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Устанавливаю зависимости Python...'
    & $python -m pip install -r (Join-Path $root 'backend/requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости Python.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules'))) {
    Write-Host 'Устанавливаю зависимости frontend...'
    Push-Location $frontend
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости frontend.' }
    } finally { Pop-Location }
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
foreach ($port in @(8000, 5173)) {
    if (Test-NetConnection -ComputerName '127.0.0.1' -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
        throw "Порт $port уже занят. Остановите работающий сервер и повторите запуск."
    }
}
$oldDemo = $env:VITE_DEMO_MODE
$oldDatabase = $env:ORBITDUO_DB_PATH
$env:VITE_DEMO_MODE = 'false'
if ($DatabasePath) { $env:ORBITDUO_DB_PATH = $DatabasePath }
$backend = $null
$vite = $null
try {
    $backend = Start-Process -FilePath $python -ArgumentList @('-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'backend.stdout.log') -RedirectStandardError (Join-Path $logDir 'backend.stderr.log')
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($backend.HasExited) { throw "Backend завершился. Лог: $logDir/backend.stderr.log" }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/v1/health' -TimeoutSec 1
            if ($health.status -eq 'ok') { break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($attempt -eq 60) { throw "Backend не ответил. Лог: $logDir/backend.stderr.log" }
    $vite = Start-Process -FilePath (Get-Command npm.cmd).Source -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1') -WorkingDirectory $frontend -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'frontend.stdout.log') -RedirectStandardError (Join-Path $logDir 'frontend.stderr.log')
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($vite.HasExited) { throw "Frontend завершился. Лог: $logDir/frontend.stderr.log" }
        try {
            $null = Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -TimeoutSec 1 -UseBasicParsing
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($attempt -eq 40) { throw "Frontend не ответил. Лог: $logDir/frontend.stderr.log" }
    Write-Host 'OrbitDuo готов к показу:'
    Write-Host '  Frontend: http://127.0.0.1:5173'
    Write-Host '  API:      http://127.0.0.1:8000/api/v1'
    Write-Host '  Health:   http://127.0.0.1:8000/api/v1/health'
    Write-Host '  Swagger:  http://127.0.0.1:8000/docs'
    Read-Host 'Нажмите Enter, чтобы остановить оба процесса'
} finally {
    if ($vite -and -not $vite.HasExited) { & taskkill.exe /PID $vite.Id /T /F 2>$null | Out-Null }
    if ($backend -and -not $backend.HasExited) { & taskkill.exe /PID $backend.Id /T /F 2>$null | Out-Null }
    $env:VITE_DEMO_MODE = $oldDemo
    $env:ORBITDUO_DB_PATH = $oldDatabase
}
