$ws = New-Object System.Net.WebSockets.ClientWebSocket
$uri = [System.Uri]::new("ws://localhost:8768")
$cts = New-Object System.Threading.CancellationTokenSource

try {
    $ws.ConnectAsync($uri, $cts.Token).Wait()
    Write-Host "Connected to bridge"

    # Send test message in stream-json format
    $msg = '{"type":"user","message":{"role":"user","content":"Say hello in one word"}}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
    $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
    Write-Host "Sent message: $msg"

    # Wait for response (up to 90 seconds)
    $buffer = New-Object byte[] 65536
    $deadline = (Get-Date).AddSeconds(90)

    while ((Get-Date) -lt $deadline) {
        $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
        $task = $ws.ReceiveAsync($seg, $cts.Token)
        if ($task.Wait(60000)) {
            $count = $task.Result.Count
            $chunk = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count)
            $preview = $chunk.Substring(0, [Math]::Min(1000, $chunk.Length))
            Write-Host "Received ($count bytes):"
            Write-Host $preview
            break
        } else {
            Write-Host "Waiting for response..."
        }
    }
} catch {
    Write-Host "Error: $_"
} finally {
    if ($ws.State -eq "Open") {
        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $cts.Token).Wait()
    }
    $ws.Dispose()
}
