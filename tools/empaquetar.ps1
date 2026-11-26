# Arma el paquete para compartir: dist\KekeClipper-v<versión>-windows.zip
# Lleva el .exe recién compilado + los archivos del repo. Sin data\ (datos personales) ni node_modules
# (la app los instala sola la primera vez que se abre).
# Uso:  powershell -ExecutionPolicy Bypass -File tools\empaquetar.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# 1) Compilar el .exe
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "launcher\build.ps1")
if ($LASTEXITCODE -ne 0) { throw "No se pudo compilar el .exe" }

# 2) Copiar solo lo que está en git (así nunca se cuela nada personal)
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "KekeClipper"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
$files = git ls-files
if ($LASTEXITCODE -ne 0) { throw "git ls-files falló" }
foreach ($f in $files) {
  if ($f -like "tools/*" -or $f -like "docs/*") { continue }   # herramientas y capturas del repo: no hacen falta para usar la app
  $dst = Join-Path $stage $f
  New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
  Copy-Item (Join-Path $root $f) $dst
}
Copy-Item (Join-Path $root "KekeClipper.exe") $stage

# 3) Control: nada personal adentro
$bad = Get-ChildItem $stage -Recurse -File | Where-Object { $_.FullName -match "\\data\\|node_modules|config\.json$|twitch_session|\.env" }
if ($bad) { throw "Hay archivos que no deberían ir: $($bad.FullName -join ', ')" }

# 4) Comprimir
$zip = Join-Path $dist "KekeClipper-v$version-windows.zip"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Listo: $zip ($size MB, $((Get-ChildItem $stage -Recurse -File).Count) archivos)"
