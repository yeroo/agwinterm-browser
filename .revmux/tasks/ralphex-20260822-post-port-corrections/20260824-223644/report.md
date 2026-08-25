# Review: ralphex-20260822-post-port-corrections / 20260824-223644

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260822-post-port-corrections\20260824-223644\input\scope.md`

No findings.

## Pre-existing

### Pane markers prove a past placement but are treated as current ownership

`cli/src/pane.ts:729-803`

The finding is self-declared pre-existing: `allOwnedFrames` accepts any surviving marker for the current pane, then `clearOwnedPaneFrame` sends `image.clear` without establishing that the marked frame is still the pane's current placement. If browser A crashes and leaves its marker, then another producer replaces A's placement before the user runs `pane-clear`, A's historical marker still authorizes line 803 to clear the newer producer's picture. The host replaces placements wholesale, while nothing updates or invalidates A's directory on that replacement, so the filesystem evidence proves only that A drew there previously — not that it still owns what is displayed. The ownership-marker scheme and the wholesale-replacement behaviour it relies on both predate the change under review; the change did not introduce the marker-versus-current-placement gap.

_confidence: 92 | sources: adversarial | lenses: adversarial_

### Staleness is inferred from frame activity rather than publisher liveness

`engine/crates/pixel-core/src/frame_file.rs:401`

The finding is self-declared pre-existing and, per the reviewer, is explicitly documented by the changed comments rather than caused by them: every new publisher removes directories whose mtime is at least one hour old, although an idle live browser writes no frames and therefore stops refreshing that timestamp. Browser A can remain static for an hour, browser B can sweep A's directory and pane marker, and A can then be force-killed before repainting. Its placement remains displayed, but `pane-clear` has no ownership evidence and refuses to clear it. `write_frame` recreates the directory only after another repaint, so it does not cover this sequence. The mtime-based reaping policy itself is untouched by the change under review, which only describes it in comments.

Fix: Use a renewable publisher lease or heartbeat distinct from frame activity, while retaining an expiry so crashed publishers are eventually reclaimed.

_confidence: 95 | sources: adversarial | lenses: adversarial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 2942134 | 0 | ok, nothing raised |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 2450209 | 0 | ok, nothing raised |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 3665585 | 0 | ok, nothing raised |
| adversarial | codex | gpt-5.6-sol | high | 134920 | 2 | ok |
