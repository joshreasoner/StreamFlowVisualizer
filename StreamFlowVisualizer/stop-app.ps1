# Stops any StreamFlowVisualizer process still holding the dev ports.
param([int[]]$Ports = @(5289, 5290))

$owners = Get-NetTCPConnection -LocalPort $Ports -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $owners) {
  $name = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName
  Write-Host "Stopping $name (PID $id)"
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
if (-not $owners) { Write-Host "Ports $($Ports -join ', ') are already free." }
