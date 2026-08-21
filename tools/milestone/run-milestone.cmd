@echo off
rem Task 10 bring-up: launch the browser into the agwinterm pane this runs in.
rem
rem Not a product entry point -- `cli/src/main.ts` is, and it still only spawns the
rem daemon (Task 13). This is the smallest thing that exercises the whole Windows
rem path end to end: Electron OSR -> pixel-core composite -> frame_file -> image.frame.
rem
rem Run it from inside a pane (agwinterm exports AGWINTERM_* into the shell), e.g.
rem   agwintermctl --pipe agwinterm-dev session new --command "...\run-milestone.cmd <url>"
rem
rem TERMINAL_BROWSER_FRAME_BUDGET and TERMINAL_BROWSER_CELL_PX are passed through if
rem the caller set them; the budget file is what docs/design/02-frame-budget.md is
rem measured from.

setlocal
set "ROOT=%~dp0..\.."
set "ELECTRON=%ROOT%\browser\node_modules\electron\dist\electron.exe"
set "MAIN=%ROOT%\browser\dist\main.js"
if "%~1"=="" (set "URL=file:///%ROOT:\=/%/tools/milestone/static-page.html") else (set "URL=%~1")

echo [milestone] pane=%AGWINTERM_SESSION_ID% pipe=%AGWINTERM_PIPE%
echo [milestone] cell=%TERMINAL_BROWSER_CELL_PX% budget=%TERMINAL_BROWSER_FRAME_BUDGET%
echo [milestone] url=%URL%
"%ELECTRON%" "%MAIN%" "%URL%"
echo [milestone] exit=%ERRORLEVEL%
endlocal
