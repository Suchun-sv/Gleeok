# Create "Gleeok" shortcuts on the desktop and in the Start menu that start Gleeok from this
# checkout, with its icon and no console window. Run it again after moving the checkout:
#   powershell -ExecutionPolicy Bypass -File deploy\windows-shortcut.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repo 'app'

Push-Location $appDir
try {
  # The last line is the path (the very first run prints a download line before it).
  $electron = (node -e "console.log(require('electron'))" | Select-Object -Last 1).Trim()
} finally {
  Pop-Location
}
if (-not (Test-Path $electron)) { throw "Electron not found ($electron). Run 'npm install' in $appDir first." }

$icon = Join-Path $appDir 'assets\icon.ico'
$shell = New-Object -ComObject WScript.Shell
# GetFolderPath follows a desktop that OneDrive has moved.
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $path = Join-Path $dir 'Gleeok.lnk'
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $electron
  $lnk.Arguments = '"' + $appDir + '"'
  $lnk.WorkingDirectory = $appDir
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Gleeok'
  $lnk.Save()
  Write-Host "Created $path"
}
