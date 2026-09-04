# Review: ralphex-20260903-adopt-image-frameshm / 20260904-152403-3614546-1948-1

scope: `C:\Users\boris\source\winterm-browser\.revmux\tasks\ralphex-20260903-adopt-image-frameshm\20260904-152403-3614546-1948-1\input\scope.md`

## Major

### The shared-memory route never refreshes or recreates its frame directory, so sweep_stale can reclaim a live publisher's only recovery evidence

`engine/crates/pixel-core/src/frame_file.rs:880-883`

On the image.frameshm route the frame directory is written exactly once, when mark_pane creates the pane marker on the first accepted frame under the `if !self.placed` guard. No later frame touches the directory, because the pixels go through the mapping. Its mtime is therefore frozen at roughly the browser's start time for the whole session, however hard the browser paints.

sweep_stale (:445) decides staleness from that mtime, holding a marked directory to MARKED_STALE_AFTER (seven days, :167). So a browser publishing over the fast path for more than seven days has its directory deleted by the next browser started anywhere on the machine, since the sweep walks the whole shared temp root. The live publisher notices nothing, because it writes no frame that would hit NotFound.

The file route survives the identical sweep, and the code says why: write_frame (:1029) recreates the directory on NotFound and calls FrameDir::remark (:401). Both mitigations are reachable only from the file route -- remark has exactly one call site, inside write_frame -- so the new default route has no path that recreates the directory and none that rewrites the marker.

Failure case: a browser left open in a pane for over a week on a host with the verb, another browser started in any pane, then the first browser force-killed. Terminal::drop never sends the clear, the directory and marker are gone, allOwnedFrames finds nothing, and pane-clear reports nothing owned against a pane that is still fully painted. That is the unrecoverable state the two-layer design exists to prevent.

The prose half is that several doc comments now assert the opposite. STALE_AFTER's doc (:115-121) rests the design on "a publisher that is painting refreshes its directory's timestamp for free: every frame creates a file inside it", sweep_stale's doc (:431-433) repeats it, FrameDir::remark's doc names the idle-reclaim case it no longer covers, and docs/design/07-as-built.md:62 states the marker "is rewritten if something removes the directory out from under a live publisher". None of these holds on the mapping route.

A second, shorter window: the directory is unmarked until the first accepted frame, so a publisher that has placed nothing for an hour is swept under STALE_AFTER; the first accepted frame's mark_pane then writes into a directory that no longer exists, fails silently as designed, and sets self.placed without ever putting a marker on disk.

A prior review round raised the same defect against the one-hour threshold; the marked threshold narrows the window but does not close it, and the commit message on 97b7e91 records the issue as still open.

Fix: In publish_shm's accepted arm, when self.placed is already true, check the directory still exists and, if not, create_dir_all plus self.dir.remark() before returning. Recreating it also refreshes the mtime, which keeps the sweep away. Failing that, correct the invariants at :115-121, :431-433, FrameDir::remark's doc and 07-as-built.md:62 so they no longer claim a painting publisher stays fresh on both routes.

_confidence: 99 | sources: adversarial, arch+quality, docs+tests, bugs+impl | lenses: adversarial, architecture, comments, docs, bugs, impl | verdict: confirmed_

## Minor

### Three comments still name the written.is_empty() clear guard this change replaced with placed

`engine/crates/pixel-core/src/frame_file.rs:1202`

This branch moved FramePublisher::clear's ownership test off written.is_empty() and onto the new placed flag (:748), and carried the rename through the CLI module comment, the marker constant's doc, :728 and pane-clear.test.mjs. Three sites in this file still describe the old guard as current:

- :1202, in write_all_new: "That is the very thing FramePublisher::clear's written.is_empty() guard exists to refuse."
- :986, in publish_encoded: "this publisher declines to do when written is empty"
- :2118, in a_frame_the_host_refused_names_no_pane: "Same rule as clear's written.is_empty()"

The distinction is not cosmetic. written is still a live field, now only the retention list reap trims, so these read as a real guard rather than an obvious relic. Under the fast path written is permanently empty while a placement exists, so a maintainer following any of the three concludes that a shm publisher never clears -- the opposite of what clear does. The :1202 one is the worst: it is the explanation of why a failed write must leave no marker behind, and the argument for why discard_partial exists at all, which is the load-bearing reasoning for the very ownership rule this change moved.

Pre-existing text, but the branch is what made it false, and this diff is the sweep that converted every other written mention. Prose only, so nothing runs wrong.

Fix: Replace all three with placed, matching the wording already used at :728 and on the PANE_FILE constant.

_confidence: 99 | sources: bugs+impl, arch+quality | lenses: impl, architecture | verdict: confirmed_

### check_transmitted's doc still calls the untransmitted warning once-per-publisher after this change made it per-route

`engine/crates/pixel-core/src/frame_file.rs:1066`

This diff replaced the single warned_untransmitted boolean with the Warned struct (:1144), so each route latches its own complaint, and updated the inline comment at :1100-1106 to say "Said once per route, but decided every frame". Two comments describing the same latch were not updated and now contradict it:

- :1066, in check_transmitted's own doc, immediately above the code that changed: "it does not spend the once-per-publisher warning below."
- :2979, in the test comment for the cache-hit case: "rather than spending the once-per-publisher stale-frame warning."

The same function states the rule twice and gets it right once, and the test at :2958 asserts the new behaviour in as many words, "once per route, not once per publisher", directly under a comment saying the opposite. Both stale sites sit next to lines this diff edited. The claim matters because the point of introducing Warned is that the mapping route's complaint must not spend the file route's; a doc still saying the latch is per publisher describes the bug that was just fixed. Prose only, so nothing runs wrong.

Fix: Say "once per route" in both comments and point at Warned, matching the assertion at :2958.

_confidence: 99 | sources: bugs+impl, arch+quality | lenses: impl, quality | verdict: confirmed_

### The producer module doc cites the third rule for a guarantee the second rule carries

`engine/crates/pixel-core/src/frame_shm.rs:1504`

The first of the four rules in the producer module doc ends: "A second producer in the same process starts its own count at 1 -- that is safe only because the third rule gives it names of its own."

Counting the bullets that follow, the third rule is at :1514, "A name is this process's alone, not its pid's", which is about process_start separating this process from an earlier holder of the same pid. It does nothing about two producers alive in the same process, which share both the pid and the start.

What actually makes a second producer safe is the tail of the second bullet at :1510-1513: "The suffixes are the only thing that tells two producers of one process apart -- the pid is the process's -- so each producer owns a range of them ([producer::RANGE]) and none is ever offered by two."

A reader who follows the pointer lands on process-level uniqueness, finds nothing about a second producer, and is left believing the restarted sequence is unexplained. The sentence is new in this diff. Prose only.

Fix: Say "the second rule", or refer to producer::RANGE by name rather than by bullet position.

_confidence: 99 | sources: docs+tests, bugs+impl | lenses: docs, comments, impl | verdict: confirmed_

### The verb is documented as being in no agwinterm release, but v0.17.10 carries it

`engine/crates/pixel-core/src/frame_shm.rs:145`

Transport::unavailable_reason builds the once-per-session warning a user sees when they set the transport variable to shm on a host that refuses the verb. It tells them the verb "is on agwinterm main from 8230d0e and in no release as of 2026-09". That is wrong.

In the agwinterm checkout, `git tag --contains 8230d0e` answers v0.17.10. The tag was created 2026-09-03 at 22:04, about three and a half hours after 8230d0e landed at 18:38 the same day, and grepping image.frameshm at v0.17.10 in ControlServer.cs finds 18 occurrences, so the verb is in the released tree. The commit immediately after the one this branch measured against says so outright: 3c8a56f records "contract step #223; released as v0.17.10 (#224)" and adds the rule "A release follows every agwinterm batch that adds a verb."

A user reading the warning concludes they must build agwinterm from main to get the fast path, when upgrading to the current release would do. The claim is repeated in the module doc (frame_shm.rs:31), in frame_file.rs at 21, 901 and 2489, in README.md at 48 and 244, in 07-as-built.md at 28, 83 and 113, in 02-frame-budget.md:193, in 00-port-brief.md:364, in 04-cell-metrics.md:8 and in the acceptance test's skip message at frameshm.test.mjs:526. The budget doc's own parenthetical shows the fact was in hand and not followed through: it describes the measurement host as "one commit past v0.17.10" while the same sentence says the verb is in no release.

Nothing here changes what the code does. The acceptance test decides capability by probing the live host, not by this claim.

Fix: Replace "in no release as of 2026-09" with "from agwinterm v0.17.10" everywhere it appears, starting with the runtime string in unavailable_reason, and rewrite the acceptance test's skip reason and LACKS_VERB to name the release rather than a main commit.

_confidence: 95 | sources: docs+tests | lenses: docs, comments | verdict: confirmed_

### PAGE's doc claims each slot starts on a page, and none of them does

`engine/crates/pixel-core/src/frame_shm.rs:215`

The doc on PAGE reads "Slot strides are rounded up to this, so each slot starts on a page."

Slot pixels start at pixel_offset + slot * slot_stride (Layout::pixels, :323-327), and pixel_offset is HEADER_LEN, a constant 256 (:282-284). So slot 0 begins 256 bytes into the view and slot 1 begins at 256 + slot_stride. Rounding the stride to 4096 keeps the slots a whole number of pages apart, but it cannot move either of them onto a page boundary, because the region they are measured from is not on one. The view base is allocation-granularity aligned, so the 256-byte offset is exactly what stands between the slots and page alignment.

The layout itself is fine and matches the spec, which fixes pixelOffset at 256; only the stated rationale is false. Nothing depends on it today, since ready's SAFETY argument at :910-917 reasons from the 8-byte alignment of offset 32 rather than from PAGE, but this is the file's authoritative description of its own memory layout, and a later reader taking the alignment claim at face value would be wrong.

Fix: Say what the rounding actually buys: the slots sit a whole number of pages apart, so each slot's pixels occupy pages no other slot writes.

_confidence: 90 | sources: bugs+impl | lenses: impl | verdict: confirmed_

### frame:0/0 is described as the answer of a host that cannot open the mapping, which the contract rules out

`engine/crates/pixel-core/src/frame_file.rs:865`

The comment in publish_shm reads: "frame:0/0 is 'nothing was placed' in an ok:true envelope, exactly as on the file path - and, on this path, the answer of a host that cannot open the mapping at all, on every frame." The complaint text this feeds, Source::Mapping's arm of unopenable at :1174, tells the user "it could not open the mapping {name}, so the pane has been left blank. The name is in the Local\ namespace, so the process hosting the pane must be in this logon session."

The contract says the opposite. docs/specs/image-frameshm.md states that a frame is all-or-nothing: "If any entry in images is rejected - a bad number, a name outside the prefix, a slot that overruns the view, or a request limit being exceeded - the whole request answers {\"ok\":false,...}", and "the mapping does not exist" is listed in the reader's validation table as one of those rejections. HandleImageFrameShm in ControlServer.cs matches: a TryReadFrame that fails returns Err("image.frameshm: " + Describe(error)). The reply is frame:{count}/{transmits} where count is the number of staged images, so frame:0/0 requires an empty images array, which this producer never sends.

A host that cannot open the mapping therefore reaches the Reply::Err arm, not this one. The consequence is a diagnostic that cannot fire pointing the reader at logon sessions, and the same wrong story told in two test comments: a_frame_the_host_placed_none_of_over_shm_goes_out_over_the_file and a_host_that_can_open_neither_the_mapping_nor_the_directory_is_told_about_both, whose stated scenario of a pane in another logon session answering frame:0/0 to the mapping is not a scenario the host produces.

The handling itself is fine and worth keeping: an unexpected frame:0/0 is correctly treated as not a placement and re-sent over the file.

Fix: Rewrite the comment and the Source::Mapping message to say what the reply actually is on this route - an ok that staged nothing, which the contract does not produce for a single-image request, handled defensively - and drop the logon-session advice, which belongs on the Reply::Err path where the host's own message already carries the reason.

_confidence: 85 | sources: docs+tests | lenses: comments, docs | verdict: confirmed_

### A pid the per-case teardown force-killed itself stays queued for a second tree kill

`tools/acceptance/frameshm.test.mjs:397`

The comment at lines 386 to 388 states the rule and its reason: the pid is "taken back off the queue once the browser is confirmed gone, because forceKill inspects nothing and the pid of a dead process is one Windows hands out again - to the next case's Electron, say."

The branch three lines below breaks it:

```js
await settlesWithin(() => !alive(pid), "the browser to leave with its session", EXIT_MS).then(
  () => strays.splice(strays.indexOf(pid), 1),
  () => forceKill(pid),
);
```

Only the resolve arm dequeues. The reject arm force-kills the pid and leaves it in strays, so the file-level teardown runs an unconditional `taskkill /F /T` against that number again after every case has finished. By then the pid is dead and reusable, and the kill is a tree kill, so anything Windows has since given the number loses its whole process tree. That is the exact hazard the comment above says the dequeue exists to prevent.

A browser that fails to exit within EXIT_MS is the ordinary way in: the case times the browser out, kills it, and queues a second unconditional tree kill for the end of the run. It needs rapid pid reuse to bite, so the impact is confined to an unusual test-machine path, and the retained entry carries no diagnostic value either, because forceKill swallows every error.

Fix: Dequeue in the reject arm too, after forceKill(pid) has run: the pid is dead by then and is exactly the case the comment describes.

_confidence: 98 | sources: adversarial, docs+tests | lenses: adversarial, comments | verdict: confirmed_

### The suite's stray-browser assertion is green by construction

`tools/acceptance/frameshm.test.mjs:251`

The file-level teardown collects failures from force-killing every browser still queued and asserts the list is empty:

```js
const failures = await teardown(...strays.map((pid) => () => forceKill(pid)));
assert.deepEqual(failures, [], "a browser of this suite would not die");
```

teardown in tools/lib/deadline.mjs:135 builds its list purely from steps that throw. forceKill at line 255 wraps its execFileSync in `try { ... } catch { }` with the comment "Already gone, which is the state the caller wanted", so it never throws for any reason: not a taskkill that timed out, not one denied access, not a pid that is still alive after the call.

So failures is [] on every run and the assertion cannot fail. If an Electron the suite launched survives the whole run, the suite reports success. Inverting forceKill to do nothing at all would leave this test just as green.

Fix: Either check liveness after the kill and throw when the pid is still up, so teardown has something to collect, or drop the assertion and keep forceKill as pure best-effort cleanup rather than dressing it as a check.

_confidence: 95 | sources: docs+tests | lenses: tests | verdict: confirmed_

### The deadline rejects without closing the named-pipe socket

`tools/acceptance/frameshm.test.mjs:143-148`

control races exchange against withDeadline, but a timeout only rejects the wrapper promise; exchange retains an open net.Socket and has no timeout or cancellation path. If the host accepts the pipe connection and then never replies, the test reports its timeout after five seconds but the live socket remains an active Node handle, so the file can still hang until the runner's outer timeout. The identical implementation in tools/milestone/measure-transports.mjs:107 has the same failure mode, contradicting the plan's requirement that every wait be bounded.

Fix: Make the exchange deadline destroy its socket when it expires, and apply the same cancellation in measure-transports.mjs.

_confidence: 92 | sources: adversarial | lenses: adversarial | verdict: confirmed_

### New comment claims frames-without-marker is a shape no route produces, and the file route still produces it

`cli/src/pane.ts:641-642`

The comment says frames with no marker beside them are "the one shape neither route produces today - an engine predating the marker". The file route produces it routinely. write_all_new creates frame-00000000.png before the image.frame request goes out, and mark_pane only runs after the host's reply comes back, so a browser force-killed inside that window leaves a directory holding a frame file and no marker.

The same repository documents that shape as a live case in the other direction: write_all_new's comment at frame_file.rs:1196-1202 spells out "a browser whose only write failed placed nothing and wrote no PANE_FILE marker; on the pid path allOwnedFrames adopts exactly that shape - frames present, marker absent".

A reader who believes this comment concludes the frame-file count in allOwnedFrames is dead code kept for old engines, and could delete the branch that adopts an unmarked wreck by pid, which is the branch that recovers a browser killed mid-first-frame.

Fix: Say that the shape is produced by a browser killed between the frame-file write and the host's reply, which is why the pid question still adopts it, rather than attributing it to an older engine.

_confidence: 90 | sources: arch+quality | lenses: architecture | verdict: confirmed_

### A docs-check comment claims a version check the assertion below it does not make

`tools/docs-check/docs.test.mjs:239-241`

The last assertion of the new budget-table test is introduced by:

```js
// And the build is not older than the verb, which is the one commit the whole
// plan hangs on.
assert.ok(doc.includes("`8230d0e`"), "the doc no longer names the commit the verb landed in");
```

The assertion is a substring search. It establishes that the string 8230d0e appears somewhere in the document, and says nothing about whether the build the comparison cites is a descendant of it. The regex above matches any 7-to-40 hex digits after "Release host at", so the doc could cite a commit that predates the verb entirely and both assertions would still pass.

The test file is explicit elsewhere about the limits of what it checks -- the doc comment above says "git ls-remote is not available here, so the check is the shape of a short hash, not its existence" -- which makes this line read as a stronger guarantee than the file itself claims, to a maintainer deciding whether the citation is pinned.

Fix: Reword to what the line does: the doc still names the commit the verb landed in. If the ordering check is wanted, it needs the agwinterm repo, which this test does not have.

_confidence: 85 | sources: docs+tests | lenses: comments, tests | verdict: confirmed_

## Immaterial

### Layout accepts frames above the host's fixed copy budget

`engine/crates/pixel-core/src/frame_shm.rs:241-258`

Layout::for_frame validates each dimension against 16384 but omits the normative 268,435,456-byte per-request frame limit enforced by the host. For example, 8192x8193 is accepted here, creates a roughly 512 MiB two-slot mapping, and copies 268,468,224 bytes before every image.frameshm request is deterministically rejected as too large. The publisher repeats this work for three frames before latching to the file path. So a valid canvas within the advertised dimension bounds incurs large commit and copy costs for a route that cannot succeed.

Fix: Reject layouts where width * height * 4 exceeds the host's shared-frame byte limit before creating or filling a mapping, allowing the existing file fallback to run directly.

_confidence: 95 | sources: adversarial | lenses: adversarial | verdict: immaterial_

## Sources

| agent | executor | model | effort | tokens | raised | status |
| --- | --- | --- | --- | --- | --- | --- |
| bugs+impl | claude | claude-opus-5 (requested opus) | high | 4341225 | 6 | ok |
| arch+quality | claude | claude-opus-5 (requested opus) | high | 6654470 | 4 | ok |
| docs+tests | claude | claude-opus-5 (requested opus) | high | 9140185 | 7 | ok |
| adversarial | codex | gpt-5.6-sol | high | 233074 | 4 | ok |
