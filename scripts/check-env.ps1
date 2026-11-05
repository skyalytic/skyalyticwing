$key = $env:TAURI_SIGNING_PRIVATE_KEY
$pwd = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if ($key) {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY is SET, length: $($key.Length)"
    Write-Host "  First 30 chars: $($key.Substring(0, [Math]::Min(30, $key.Length)))..."
} else {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY is NOT SET"
}
if ($pwd) {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is SET (length: $($pwd.Length))"
} else {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is NOT SET"
}
