#
# Install the Zen Sidebar Sync native messaging host on Windows.
# Run: powershell -ExecutionPolicy Bypass -File install.ps1 [-Uninstall]
#
param([switch]$Uninstall)

$ManifestName = "zen_sidebar_sync"
$ExtensionId = "zen-sidebar-sync@luftaquila"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostBat = Join-Path $ScriptDir "zen_sidebar_native.bat"
$HostPy = Join-Path $ScriptDir "zen_sidebar_native.py"
$InstallDir = Join-Path $env:LOCALAPPDATA "ZenSidebarSync"
$RegPath = "HKCU:\SOFTWARE\Mozilla\NativeMessagingHosts\$ManifestName"

if ($Uninstall) {
    Write-Host "Uninstalling native messaging host..."
    if (Test-Path $RegPath) {
        Remove-Item $RegPath -Force
        Write-Host "Removed registry key: $RegPath"
    }
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "Removed: $InstallDir"
    }
    Write-Host "Done."
    exit 0
}

# Check Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "Error: python is required but not found in PATH" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $HostPy)) {
    Write-Host "Error: zen_sidebar_native.py not found in $ScriptDir" -ForegroundColor Red
    exit 1
}

# Copy files to install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
Copy-Item $HostPy -Destination $InstallDir -Force
Copy-Item $HostBat -Destination $InstallDir -Force
Write-Host "Installed host script: $InstallDir"

$InstalledBat = Join-Path $InstallDir "zen_sidebar_native.bat"
$ManifestPath = Join-Path $InstallDir "$ManifestName.json"

# Create manifest (path must use forward slashes or escaped backslashes in JSON)
$ManifestPathEscaped = $InstalledBat -replace '\\', '\\'
$Manifest = @"
{
  "name": "$ManifestName",
  "description": "Zen Sidebar Sync - reads Zen session store for workspace/essential data",
  "path": "$ManifestPathEscaped",
  "type": "stdio",
  "allowed_extensions": ["$ExtensionId"]
}
"@
$Manifest | Out-File -Encoding utf8 -FilePath $ManifestPath
Write-Host "Created manifest: $ManifestPath"

# Register in Windows Registry
if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath
Write-Host "Registered in registry: $RegPath"

Write-Host ""
Write-Host "Native messaging host installed successfully." -ForegroundColor Green
Write-Host "Restart Zen Browser for changes to take effect."
