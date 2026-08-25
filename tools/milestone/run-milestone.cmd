@echo off
rem Task 10 bring-up: launch the browser into the agwinterm pane this runs in.
rem
rem Not a product entry point -- `cli/src/main.ts` is, and since Task 13 it runs the
rem browser in the foreground itself. This is the smallest thing that exercises the
rem whole Windows path end to end with no CLI in the way: Electron OSR -> pixel-core
rem composite -> frame_file -> image.frame.
rem
rem Run it from inside a pane (agwinterm exports AGWINTERM_* into the shell), e.g.
rem   agwintermctl --pipe agwinterm-dev session new --command "...\run-milestone.cmd <url>"
rem
rem TERMINAL_BROWSER_FRAME_BUDGET and TERMINAL_BROWSER_CELL_PX are passed through if
rem the caller set them; the budget file is what docs/design/02-frame-budget.md is
rem measured from.
rem
rem TERMINAL_BROWSER_ALLOW_PIPE defaults to agwinterm-dev here rather than being
rem inherited, because this script is the one that launches a debug engine into
rem whatever pane it happens to be started from. Run it in a pane of the real
rem instance by mistake and the browser publishes there -- which is how a working
rem pane was found holding a dead browser's frame eighteen hours later. Set the
rem variable yourself (or to `*`) to aim it somewhere else on purpose.

setlocal
set "ROOT=%~dp0..\.."
set "ELECTRON=%ROOT%\browser\node_modules\electron\dist\electron.exe"
set "MAIN=%ROOT%\browser\dist\main.js"
if "%~1"=="" (set "URL=file:///%ROOT:\=/%/tools/milestone/static-page.html") else (set "URL=%~1")
if not defined TERMINAL_BROWSER_ALLOW_PIPE set "TERMINAL_BROWSER_ALLOW_PIPE=agwinterm-dev"

echo [milestone] pane=%AGWINTERM_SESSION_ID% pipe=%AGWINTERM_PIPE% allow=%TERMINAL_BROWSER_ALLOW_PIPE%
echo [milestone] cell=%TERMINAL_BROWSER_CELL_PX% budget=%TERMINAL_BROWSER_FRAME_BUDGET%
echo [milestone] url=%URL%
"%ELECTRON%" "%MAIN%" "%URL%"
echo [milestone] exit=%ERRORLEVEL%
endlocal
