@echo off
rem Task 14 acceptance: the file-based frame path, with the fast path explicitly asked for.
rem
rem `TERMINAL_BROWSER_FRAME_TRANSPORT=shm` names `image.frameshm`, which this build
rem does not produce and agwinterm does not answer -- so this is the fallback under
rem test. It must publish anyway, over `image.frame`, and say why exactly once.
rem
rem The budget TSV is the evidence: its `publish_ms` column is the `image.frame`
rem round trip, so a file with rows in it is a frame that went out over the file path.
rem
rem   run-fallback.cmd <tsv-path> [url]

setlocal
set "ROOT=%~dp0..\.."
set "TERMINAL_BROWSER_FRAME_TRANSPORT=shm"
if not "%~1"=="" set "TERMINAL_BROWSER_FRAME_BUDGET=%~1"
call "%~dp0run-milestone.cmd" %2
endlocal
