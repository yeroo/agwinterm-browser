# Drive one agwinterm pane over the control pipe, without going through
# `agwintermctl`.
#
# `agwintermctl session type` is the documented way to send keystrokes, but the
# text arrives as a process argument, and a trailing CR/LF does not survive argv on
# the way in — so "run this command" becomes "type this command and wait". The
# control protocol itself is one JSON object per line, so sending it directly is
# both shorter and exact about the bytes.
#
#   pane.ps1 -Pipe agwinterm-dev -Target <id> -Type 'echo hi'      # types, then Enter
#   pane.ps1 -Pipe agwinterm-dev -Target <id> -Text                # dump the buffer
#   pane.ps1 -Pipe agwinterm-dev -Send '{"cmd":"tree"}'            # any raw command
param(
  [string]$Pipe = 'agwinterm-dev',
  [string]$Target,
  [string]$Type,
  [switch]$Text,
  [string]$Send
)

function Invoke-Control([string]$json) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(3000)
  $writer = New-Object System.IO.StreamWriter($client)
  $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine($json)
  $reply = $reader.ReadLine()
  $client.Dispose()
  return $reply
}

if ($Send) { Invoke-Control $Send; return }

if ($PSBoundParameters.ContainsKey('Type')) {
  # The newline is the Enter: the host rewrites LF to CR before it reaches the pty.
  $payload = @{ cmd = 'session.type'; target = $Target; args = @{ text = $Type + "`n" } }
  Invoke-Control ($payload | ConvertTo-Json -Compress -Depth 5)
  return
}

if ($Text) {
  $payload = @{ cmd = 'session.text'; target = $Target }
  $reply = Invoke-Control ($payload | ConvertTo-Json -Compress -Depth 5)
  ($reply | ConvertFrom-Json).result
  return
}

Write-Error 'nothing to do: pass -Type, -Text or -Send'
