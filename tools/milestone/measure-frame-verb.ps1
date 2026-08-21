# The host's half of one `image.frame`: dispatch + File.ReadAllBytes + the brief
# placement lock, measured from outside the browser so it is separable from
# whatever the Rust client spends. Each run points at a *fresh copy* of the PNG,
# because `ContentSignature` is path-and-mtime based and a repeated path would be
# answered from the cache -- which would measure the wrong thing.
param([Parameter(Mandatory=$true)][string]$Png,
      [Parameter(Mandatory=$true)][string]$Target,
      [string]$Pipe = 'agwinterm-dev', [int]$Cols = 79, [int]$Rows = 29, [int]$Runs = 10)

$tmp = Join-Path $env:TEMP ("frame-verb-" + $PID)
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$times = @()
foreach ($i in 1..$Runs) {
  $copy = Join-Path $tmp "f$i.png"
  Copy-Item $Png $copy -Force
  $json = '{"cmd":"image.frame","target":"' + $Target + '","args":{"images":[{"id":1,"path":"' +
          $copy.Replace([string][char]92, [string][char]92 + [char]92) + '","row":0,"col":0,"cols":' + $Cols + ',"rows":' + $Rows + '}]}}'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $c.Connect(2000)
  $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
  $r = New-Object System.IO.StreamReader($c)
  $w.WriteLine($json)
  $reply = $r.ReadLine()
  $sw.Stop(); $times += $sw.Elapsed.TotalMilliseconds
  $c.Dispose()
}
Remove-Item $tmp -Recurse -Force
$sorted = $times | Sort-Object
[pscustomobject]@{
  bytes    = (Get-Item $Png).Length
  reply    = $reply
  medianMs = [math]::Round($sorted[[int]($Runs / 2)], 2)
  minMs    = [math]::Round($sorted[0], 2)
}
