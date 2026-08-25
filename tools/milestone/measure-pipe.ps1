# The fixed cost of one control-pipe round trip, with no image in it.
#
# `publish_ms` in the frame-budget file barely moves with frame size, so most of it
# is not the frame -- it is connect/write/read/parse on the pipe plus agwinterm's
# dispatch. `image.frameshm` (Task 12) removes the PNG and the file but keeps this
# request, so this is the floor the fast path cannot go below.
param([string]$Pipe = 'agwinterm-dev', [string]$Target = '', [int]$Runs = 25)

$times = @()
foreach ($i in 1..$Runs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $c.Connect(2000)
  $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
  $r = New-Object System.IO.StreamReader($c)
  $w.WriteLine('{"cmd":"ping"}')
  $null = $r.ReadLine()
  $sw.Stop(); $times += $sw.Elapsed.TotalMilliseconds
  $c.Dispose()
}
$sorted = $times | Sort-Object
[pscustomobject]@{
  runs     = $Runs
  medianMs = [math]::Round($sorted[[int]($Runs / 2)], 2)
  minMs    = [math]::Round($sorted[0], 2)
  p90Ms    = [math]::Round($sorted[[int]($Runs * 0.9)], 2)
}
