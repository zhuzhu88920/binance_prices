# check-edge.ps1 - Check if Edge is listening on debug port
$tcp = New-Object System.Net.Sockets.TcpClient
try {
    $tcp.Connect('localhost', 9222)
    if ($tcp.Connected) { exit 0 } else { exit 1 }
} catch { exit 1 }
finally { $tcp.Close() }
