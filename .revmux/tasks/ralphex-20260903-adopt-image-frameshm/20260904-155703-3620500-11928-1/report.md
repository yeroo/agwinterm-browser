# Review: ralphex-20260903-adopt-image-frameshm / 20260904-155703-3620500-11928-1

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260903-adopt-image-frameshm\20260904-155703-3620500-11928-1\input\scope.md`

## Minor

### README's summary still says the fast-path cases skip on a release, contradicting the acceptance section this change corrected 220 lines below

`README.md:44`

Line 44 still reads that the two node cases needing a host with `image.frameshm` "skip on a release". This change rewrote the same file's acceptance-suite section at lines 265-268 to say the opposite: a pane of an instance at v0.17.10 or later (the installed release, or a build with `--app-id agwinterm-dev`) runs those two and skips the fallback case instead.

v0.17.10 was tagged 2026-09-03 and is the earliest tag containing 8230d0e, confirmed with `git tag --contains 8230d0e` in the agwinterm checkout, so a release host now has the verb. The suite agrees: the fallback case's guard at tools/acceptance/frameshm.test.mjs:549 skips when `host.capable`.

A reader on an up-to-date agwinterm who runs the suite sees the fallback case skip and the two fast-path cases pass, the exact inverse of what the front-page summary told them to expect. The version sweep updated the second passage and not the first. This line was written on this branch (commit 66dcc7d), so it is introduced here rather than pre-existing.

Fix: Reword line 44 to match lines 265-268, making the skipped case depend on the host version rather than on "a release": before v0.17.10 the two fast-path cases skip, at v0.17.10 or later the fallback case skips instead. Or drop the parenthetical and let line 266 carry the detail.

_confidence: 99 | sources: bugs+impl, arch+quality | lenses: impl, architecture | verdict: confirmed_

### The recorded Rust test count is left at 524 while the branch now carries four more tests, and the docs-check guard cannot catch it

`README.md:43`

README.md:43 and docs/design/06-acceptance.md:223 both record 524 passed for `cargo nextest run --workspace`, and both are understated — by four, not three.

Three come from the working diff, which adds `#[test]` functions and removes none: `a_directory_swept_from_under_a_shm_publisher_is_recreated_with_its_marker` and `a_marked_directory_that_has_gone_quiet_gets_its_marker_rewritten_and_its_age_reset` in frame_file.rs, and `a_frame_past_the_hosts_byte_limit_is_rejected_before_a_mapping_exists` in frame_shm.rs. A grep of the diff for added and removed test attributes gives 3 and 0; the one other renamed function is a rename, not an addition.

The fourth is already committed and already uncounted. 97b7e91 adds one `#[test]` to frame_file.rs and its own message records the run as 525 Rust, yet neither recorded number moved off 524. That arithmetic agrees with the previous reviewer's note of 471 passing in pixel-core: 467 recorded, plus one from 97b7e91, plus three from the diff. With the 57 from the table's own breakdown that lands at 528.

This is a number the branch maintains every round rather than a stale artifact: over the preceding commits it runs 467, then 523, then 524, each bump landing with the tests that caused it.

The guard cannot see it. The docs-check case at tools/docs-check/docs.test.mjs:675 holds the README's count to the acceptance table's count and to nothing else, so two copies stale by the same amount stay green — the failure mode its own doc comment describes, one step removed.

One site the original finding did not name goes stale with these: docs/design/06-acceptance.md:224 records `cargo test --workspace` as 467 + 57 passed, whose first term is the same pixel-core count.

The destination number here is inferred from the diff and from the previous reviewer's reported pixel-core figure, not measured, since this review may not run the suite.

Fix: Bump both recorded counts to what a fresh `cargo nextest run --workspace` reports — 528 by the arithmetic above — in README.md:43 and docs/design/06-acceptance.md:223, and move the 467 + 57 breakdown on docs/design/06-acceptance.md:224 with them.

_confidence: 90 | sources: arch+quality | lenses: architecture, quality | verdict: refined_

### New PAGE comment claims slots never share a page, which the layout arithmetic contradicts

`engine/crates/pixel-core/src/frame_shm.rs:221-224`

The replacement comment says the page rounding exists "so that the slots sit a whole number of pages apart: each slot's pixels occupy pages no other slot writes". The first clause is true and the second does not follow from it.

Pixels start at HEADER_LEN, which is 256, and slot k begins at 256 plus k times slot_stride, with slot_stride a multiple of 4096. Slots being a whole number of pages apart therefore means every slot boundary sits 256 bytes into a page, not on one. Slot zero ends at offset 255 plus slot_bytes; slot one begins at 256 plus slot_stride. Those two offsets fall in the same page whenever slot_bytes leaves a remainder of zero or at least 3841 modulo 4096.

A remainder of zero is the ordinary case, not a corner. At the resolution the spec uses for its transport example, 1920 by 1080, slot_bytes is 8,294,400, exactly 2025 times 4096. Slot zero's last 256 bytes and slot one's first 3840 bytes both land in page 2025, so that page is written by both slots. Any width that is a multiple of 1024 gives the same result for every height.

Nothing breaks at runtime. Byte-granular writes to a shared page are correct on x86 and the producer only ever writes the inactive slot, so the cost is at most cache-line sharing. The defect is that a reader who later reasons about slot isolation from this comment reasons from something false, in the file where that kind of reasoning is the whole point.

Fix: State what the rounding actually buys: the slot stride is a whole number of pages, so a slot boundary always sits at the same offset within a page and the descriptor arithmetic stays simple. Drop the non-exclusive-pages claim, or qualify it as holding only when slot_bytes leaves a remainder between 256 and 3840 modulo the page size.

_confidence: 85 | sources: docs+tests | lenses: docs, comments | verdict: confirmed_

### PANE_FILE doc says the marker is the only file on the mapping route; remark can leave a second one

`engine/crates/pixel-core/src/frame_file.rs:204-206`

The PANE_FILE doc, rewritten by this change, still says "On the mapping route it is the *only* file the directory ever holds — the pixels went through the mapping, and nothing is written beside it" (frame_file.rs:204-206). The same diff makes that untrue.

remark now stages the marker as pane.staged and renames it into place (frame_file.rs:427-434), and its own new doc at line 425 says so out loud: "The staged name has no `frame-` prefix and is not [`PANE_FILE`], so `allOwnedFrames` counts it as nothing should a rename ever fail." A failed rename leaves pane.staged beside the marker for the life of the publisher, and a successful one puts it there transiently.

The mapping route is the route that gained the second file: keep_fresh is called on every accepted image.frameshm frame, and it calls remark when the directory is missing or has gone REFRESH_AFTER without a write. So remark runs on recreate and once per ten idle minutes rather than on every frame, but on this route it runs at all, which is what the doc denies.

No consumer is misled. The FRAME_FILE pattern in cli/src/pane.ts matches only frame-<digits>.png, so pane.staged is counted as nothing, and the retention reaper works from an in-memory list rather than a directory scan. The defect is that two comments in one file, both written by this change, now state opposite things about the same directory, and a later reader cannot tell which to trust. The identical claim also sits unrevised at cli/src/pane.ts:631 and docs/design/07-as-built.md:201.

Fix: Soften the PANE_FILE sentence to say the marker is the only file the mapping route leaves at rest, and that remark's staged name is the one exception, pointing at remark. Update the two mirrored claims in cli/src/pane.ts and docs/design/07-as-built.md to match.

_confidence: 85 | sources: docs+tests | lenses: comments, docs | verdict: refined_

### Source::unopenable's doc still describes the message the change replaced

`engine/crates/pixel-core/src/frame_file.rs:1251-1252`

The doc on this method reads "The half of the `frame:0/0` complaint that names what the host could not open, and what to check." This change rewrote the Mapping arm underneath it so that it no longer does either.

The new Mapping text at lines 1260 to 1265 says the host "staged nothing from the mapping", then states the opposite of the doc: "The contract answers a mapping it cannot open with a refusal that says why, not with this." The advice half is gone too. The old message told the user to check that the pane's host is in this logon session; the replacement names no check at all, only that the host is not the one the code was written against. So for one of the two arms the doc describes behaviour the code does not have.

The author saw this coming for the enum itself and fixed it in the same hunk: the Source doc at line 1216 was changed from "for the complaint that it could not open it" to "for the complaint that it placed nothing from it". The method's own doc, and its name, were left behind.

The new claim was confirmed correct against the host, so the message is right and the comment is the thing to change. In agwinterm's ControlServer.cs an unopenable mapping fails ShmFrameReader.TryReadFrame and returns Err, and count is incremented once per entry in phase one, so a one-image request cannot come back as frame:0/0.

Fix: Reword the doc to cover both arms, naming what the request pointed the host at and what the user can do about it. Renaming unopenable to something route-neutral would remove the remaining misdirection, since the mapping arm is now explicitly not about an unopenable mapping.

_confidence: 80 | sources: docs+tests | lenses: comments | verdict: confirmed_

### The skip-reason constant is still labelled "the plan's wording" after this change rewrote it

`tools/acceptance/frameshm.test.mjs:55-56`

The JSDoc on line 55 reads "The plan's wording, so a skipped run says what would un-skip it." That comment exists to tell a maintainer the string is not free-form and must keep matching the plan, and it was true before this change: docs/plans/20260903-adopt-image-frameshm.md line 362-363 specifies the skip reason as "host lacks image.frameshm (agwinterm main >= 8230d0e required)" and the constant matched it verbatim.

Line 56 now reads "host lacks image.frameshm (agwinterm v0.17.10 or later required)". The plan was deliberately left as a dated record and still carries the old string, so the comment now attributes the constant to a source that says something else.

The new wording is the better one for a user reading a skipped run, since a version names something installable and the plan's premise that no release carries the verb is now false. The defect is only that the comment claims a provenance the constant no longer has, the same class as the six comment-accuracy items the prior round raised against this branch.

Fix: Replace "The plan's wording" with what the string is actually for, for example that a skipped run has to name the version that would un-skip it. If the tie to the plan is worth keeping, note that the plan's commit-hash spelling predates v0.17.10 and was superseded.

_confidence: 99 | sources: arch+quality, docs+tests | lenses: architecture, comments | verdict: confirmed_

### The one file the version sweep missed still claims every agwinterm release answers `unknown command`

`docs/design/06-acceptance.md:100-104`

This change replaced the "no release carries the verb" claim in eight places: README.md, docs/design/00-port-brief.md, 02-frame-budget.md, 04-cell-metrics.md, 07-as-built.md, both Rust modules and the acceptance test's skip reasons. A tree-wide grep for the old wording returns exactly one survivor, this callout, which still reads that the criterion is "a host that answers `unknown command`" and that is "every agwinterm release as of 2026-09, and agliteterm always".

That is now false. v0.17.10 was tagged 2026-09-03 and is the earliest tag containing 8230d0e, verified with `git tag --contains` in the agwinterm checkout. A reader consulting the acceptance criteria to decide whether their host takes the fast path is told it never will.

The following sentence compounds it: the criterion "is re-accepted against a release host by tools/acceptance/frameshm.test.mjs". On a v0.17.10 or later release the suite skips the fallback case entirely (the `host.capable` guard at tools/acceptance/frameshm.test.mjs:549), so the release host is now the one host that does not re-accept this criterion.

The same file carries the shorthand in two further places that read as stale for the same reason: line 225 records a run as skipping two cases because "this was a release host", and line 305 says two of the four cases are "skipped on a release host". Line 225 is a dated record of one run so it may be intentional, but the qualifier no longer distinguishes anything on its own. Nothing machine-checks this passage: the docs-check suite reads 06-acceptance.md only to compare its test-count table against the README.

Fix: Update the 2026-09 note the way the other eight files were updated: "every agwinterm release before v0.17.10, and agliteterm always", matching 07-as-built.md line 87 and frame_file.rs line 21. Say the fallback case is re-accepted against a pre-v0.17.10 host rather than against "a release host", and consider qualifying lines 225 and 305 with the version too.

_confidence: 99 | sources: bugs+impl, arch+quality, docs+tests | lenses: impl, architecture, docs | verdict: confirmed_

## Pre-existing

### The as-built plan still says an unopenable mapping returns frame:0/0

`docs/plans/20260903-adopt-image-frameshm.md:319-322`

This completed, explicitly "as built" bullet says a host unable to open the mapping answers `frame:0/0` on every frame. The contract and the corrected `publish_shm` comment establish that this failure is an `ok:false` refusal; `frame:0/0` is only defensive handling for a response this one-image request should not produce. Leaving the plan as a dated record does not justify this non-temporal contract contradiction, and the project profile treats a plan left describing behavior the code does not have as reportable.

The reporting source states the problem is pre-existing rather than introduced by the current diff, so it is routed here rather than merged into the change's findings.

Fix: Rewrite the bullet to say mapping-open failures are refusals and that `frame:0/0` is handled defensively.

_confidence: 96 | sources: adversarial | lenses: adversarial_

### Kill-verification failure retains only a reusable PID for the final retry

`tools/acceptance/frameshm.test.mjs:422-424`

If `forceKill(pid)` cannot confirm termination within `EXIT_MS`, its rejection skips the unconditional `splice`, leaving the bare numeric PID in `strays`. The file-level hook later issues another unconditional `taskkill /F /T` for that number. If the original browser exits between those attempts and Windows reuses its PID, cleanup kills the replacement process tree. This requires a failed first verification followed by exit and PID reuse, so it is an unusual test-machine path, but it is the same identity hazard this change is intended to remove.

Fix: Do not retry a failed cleanup later using only the PID, or record and verify process identity such as creation time before issuing the second tree kill.

_confidence: 85 | sources: adversarial | lenses: adversarial | verdict: pre_existing_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 4437010 | 2 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 3592736 | 4 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 4016280 | 5 | ok |
| adversarial | codex | gpt-5.6-sol | high | 163087 | 2 | ok |
