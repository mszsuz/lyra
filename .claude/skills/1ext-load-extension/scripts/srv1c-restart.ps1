$svc = "srv1c-8440-Lyra-TEST"

# Stop
Stop-Service $svc -Force -ErrorAction Stop
Write-Host "Stopping..."
$sw = [Diagnostics.Stopwatch]::StartNew()
while ((Get-Service $svc).Status -ne 'Stopped') {
    if ($sw.ElapsedMilliseconds -gt 30000) { throw "Stop timeout" }
    Start-Sleep -Milliseconds 500
}
Write-Host "Stopped ($([int]$sw.ElapsedMilliseconds)ms)"

# Start
Start-Service $svc -ErrorAction Stop
Write-Host "Starting..."
$sw.Restart()
while ((Get-Service $svc).Status -ne 'Running') {
    if ($sw.ElapsedMilliseconds -gt 30000) { throw "Start timeout" }
    Start-Sleep -Milliseconds 500
}
# Wait for HTTP
$ready = $false
while (-not $ready -and $sw.ElapsedMilliseconds -lt 30000) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8440/" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true }
    } catch { Start-Sleep -Milliseconds 1000 }
}
if ($ready) {
    Write-Host "Running ($([int]$sw.ElapsedMilliseconds)ms)"
} else {
    Write-Host "Service started but HTTP not ready"
}
