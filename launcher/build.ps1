# Compila KekeClipper.exe con el compilador de C# que ya trae Windows (.NET Framework 4.x).
# Uso:  powershell -ExecutionPolicy Bypass -File launcher\build.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Add-Type -AssemblyName System.Drawing

# ---------- Ícono (se dibuja acá mismo, sin archivos externos) ----------
function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"; $g.Clear([System.Drawing.Color]::Transparent)
  $r = [single]($size * 0.22); $s = [single]$size
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $path.AddArc($s - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($s - 2 * $r, $s - 2 * $r, 2 * $r, 2 * $r, 0, 90); $path.AddArc(0, $s - 2 * $r, 2 * $r, 2 * $r, 90, 90); $path.CloseFigure()
  $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(235, 20, 10)), ([System.Drawing.Color]::FromArgb(120, 0, 6)), 45
  $g.FillPath($brush, $path)
  # borde negro + cara riéndose en blanco: ojos cerrados (arcos) + boca abierta
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(10, 10, 10)), ([single][Math]::Max(1, $size * 0.04))), $path)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single]($size * 0.07))
  $pen.StartCap = "Round"; $pen.EndCap = "Round"
  $g.DrawArc($pen, [single]($s * 0.22), [single]($s * 0.30), [single]($s * 0.2), [single]($s * 0.16), 200, 140)
  $g.DrawArc($pen, [single]($s * 0.58), [single]($s * 0.30), [single]($s * 0.2), [single]($s * 0.16), 200, 140)
  $mouth = New-Object System.Drawing.Drawing2D.GraphicsPath
  $mouth.AddArc([single]($s * 0.24), [single]($s * 0.34), [single]($s * 0.52), [single]($s * 0.44), 0, 180); $mouth.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $mouth)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return ,$ms.ToArray()
}
$sizes = 256, 64, 48, 32, 16
$pngs = @{}; foreach ($z in $sizes) { $pngs[$z] = New-IconPng $z }
$ico = Join-Path $here "app.ico"
$fs = [System.IO.File]::Create($ico); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($z in $sizes) {
  $b = if ($z -ge 256) { 0 } else { $z }
  $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$pngs[$z].Length); $bw.Write([UInt32]$offset)
  $offset += $pngs[$z].Length
}
foreach ($z in $sizes) { $bw.Write($pngs[$z]) }
$bw.Close()
[System.IO.File]::WriteAllBytes((Join-Path $root "public\favicon.png"), $pngs[64])

# ---------- Compilar ----------
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "No encontré csc.exe (.NET Framework 4)." }
$lib = Join-Path $here "lib"
$out = Join-Path $root "KekeClipper.exe"
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$out" "/win32icon:$ico" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  "/r:$lib\Microsoft.Web.WebView2.Core.dll" "/r:$lib\Microsoft.Web.WebView2.WinForms.dll" `
  (Join-Path $here "KekeClipper.cs")
if ($LASTEXITCODE -ne 0) { throw "La compilación falló." }
Write-Host "Listo: $out"
