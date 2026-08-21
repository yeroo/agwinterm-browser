# What agwinterm spends on a frame *after* the control request returns.
#
# `publish_ms` in the frame-budget file stops when `image.frame` is answered; the
# host's PNG decode happens later, on its own thread (`Program.Render.cs:196`).
# This measures that half with the same calls the host makes -- `File.ReadAllBytes`
# for phase 1, then `System.Drawing.Bitmap` + `LockBits(Format32bppPArgb)` + copy,
# which is `DecodePixels` (`Program.Render.cs:212`) line for line. Not a proxy for
# the decoder: it is the decoder.
param([Parameter(Mandatory=$true)][string]$Png, [int]$Runs = 7)

Add-Type -AssemblyName System.Drawing
$fi = Get-Item $Png
$read = @(); $decode = @()
foreach ($i in 1..$Runs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $bytes = [System.IO.File]::ReadAllBytes($Png)
  $sw.Stop(); $read += $sw.Elapsed.TotalMilliseconds

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ms = New-Object System.IO.MemoryStream(,$bytes)
  $gdi = New-Object System.Drawing.Bitmap($ms)
  $w = $gdi.Width; $h = $gdi.Height
  $data = $gdi.LockBits(
    (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
    [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
    [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $buf = New-Object byte[] ($w * 4 * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $gdi.UnlockBits($data); $gdi.Dispose(); $ms.Dispose()
  $sw.Stop(); $decode += $sw.Elapsed.TotalMilliseconds
}
$med = { param($a) ($a | Sort-Object)[[int]($a.Count / 2)] }
[pscustomobject]@{
  file      = $fi.Name
  pixels    = "${w}x${h}"
  bytes     = $fi.Length
  readMs    = [math]::Round((& $med $read), 2)
  decodeMs  = [math]::Round((& $med $decode), 2)
}
