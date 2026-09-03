# Adopt `image.frameshm` as the frame fast path

## Overview

The browser publishes every frame to agwinterm over `image.frame`: PNG-encode the canvas, write
it to a file under `%LOCALAPPDATA%`, name the path over the control pipe, and let the host read
and decode it. At the largest pane measured that costs **38 ms per frame, 26 fps**, of which
**27.6 ms** is the encode and the write — work that exists only because the transport is a file
([`02-frame-budget.md`](../design/02-frame-budget.md)).

agwinterm now implements `image.frameshm` (agwinterm `8230d0e`, 2026-09-03): a named
shared-memory mapping carrying raw 4-bpp pixels, with the placement machinery of `image.frame`
unchanged. Its contract is published and versioned —
[`docs/specs/image-frameshm.md`](https://github.com/yeroo/agwinterm/blob/main/docs/specs/image-frameshm.md),
layout version 1 — and it is the contract this tree's own design section insisted on before a
producer could be written ([`00-port-brief.md` § Chosen transport](../design/00-port-brief.md#chosen-transport)).
The gate was honoured; this plan is what it was gating.

This plan adds the producer. After it:

- On a host that has the verb, frames go out as a slot in a mapping plus a small JSON request:
  no encode, no file, no decode on the host's side. The design says this deletes about 27.6 ms
  of the 38; Task 8 measures what it actually deletes.
- On a host that lacks the verb — every agwinterm **release** as of today; the verb is only on
  `main` — the first attempt gets `unknown command 'image.frameshm'`, the file path is latched
  for the session, and nothing else changes. agliteterm never implements the verb by design and
  is the permanent example of this host.
- `TERMINAL_BROWSER_FRAME_TRANSPORT` keeps its meaning: `file` forces the file path on a host
  that offers the fast one (so the baseline stays re-measurable), `shm` asks for the fast path
  and gets an explanation if it cannot have it, unset means whichever works.

The producer is the **simplest conforming one the contract describes**: two slots, one frame
in flight, every reply awaited before the next slot is filled. That is a decision (see
Constraints), not an omission.

## Context (from discovery)

Half of this already exists, and it is the half that did not depend on the layout:

- `engine/crates/pixel-core/src/frame_shm.rs` (282 lines, port-written) — `Transport`
  (`Auto`/`File`/`Shm`, parsed from `TERMINAL_BROWSER_FRAME_TRANSPORT` through `SessionEnv`),
  `unavailable_reason` (the once-per-session explanation an explicit `shm` earns), and
  `is_unknown_command` — the one reading of a host's `unknown command '…'` refusal that every
  capability probe in the crate shares. Its module doc says the producer is absent because the
  spec did not exist. The spec exists now; that doc is wrong and is rewritten in Task 9.
- `engine/crates/pixel-core/src/frame_file.rs` — `FramePublisher`: `publish` →
  `encode_png` → `publish_encoded` → `ControlClient::send(FRAME_CMD, frame_args(path, span))`.
  `cell_span` computes `cols`/`rows` for the placement; `FrameCost`/`BudgetLog` write the
  per-frame budget file `02-frame-budget.md`'s numbers are read off. It already holds
  `transport: Transport::from_env(env)` and three tests about when the shm explanation is and
  is not logged (`frame_file.rs:~1990-2130`). Its module doc opens with "Task 12 was to add
  `image.frameshm` on top, and this path stays" — still true, and this plan is Task 12.
- `engine/crates/pixel-core/src/agwinterm.rs` — `ControlClient::send(cmd, args)` returns a
  `Reply` (`Ok`/`Err(message)`); one request per connection; `push_quoted` builds JSON strings
  by hand. `pane_metrics` at `:1099` is the existing example of a capability probe that falls
  back on `is_unknown_command`.
- `engine/crates/pixel-core/src/canvas.rs` (vendored, **do not edit**) — the canvas is tiny-skia
  **RGBA**: `from_rgba`, `blit_*_rgba`. The contract accepts `format: 32` (`Rgba`) as well as
  `132` (`Bgra`), so the producer copies rows as they are. tiny-skia stores premultiplied
  alpha; browser frames are opaque, so the bytes are identical either way — Task 3 asserts that
  rather than assuming it.
- `engine/crates/pixel-node/src/lib.rs` — frames enter the engine as BGRA from Electron
  (`draw_frame`, `:192`) and are composed onto the canvas; the publisher only ever sees the
  canvas. Nothing in pixel-node changes.
- `engine/crates/pixel-core/Cargo.toml` — `windows-sys` is already a `cfg(windows)` dependency
  (for `terminal_windows.rs`); the mapping needs `Win32_System_Memory` and
  `Win32_Foundation` features, which may need adding to the workspace feature list.
- `tools/acceptance/pane-clear.test.mjs` — the pattern for a test that drives the built browser
  against a **live** pane: builds the `AGWINTERM_*` environment by hand, skips when no host is
  reachable, and bounds every wait with `tools/lib/deadline.mjs`.
- `tools/docs-check/docs.test.mjs` — two tests pin the transport docs: "the documented frame
  transports are exactly the ones the parser accepts" (`:190`) reads `frame_shm.rs`'s accepted
  values against the `07-as-built.md` table, and "the dropped fast paths name the presenter
  Windows actually runs" (`:309`). Both must stay green through Task 9's rewrite.
- agwinterm's side, for reference while implementing: `docs/specs/image-frameshm.md` (the
  contract), `src/Agwinterm.Pty/ShmFrameLayout.cs` (the reader's view of the layout),
  `tests/Agwinterm.Pty.Tests/ShmTestProducer.cs` (a producer written to the same contract, in
  C#), and `agwintermctl image frameshm <name> [--slot N] [--seq N] …` (the ctl surface, usable
  to poke a mapping this producer created).

## Constraints

- **The contract is normative and nothing in it is negotiated here.** Magic `0x46534741`,
  version `1`, a 256-byte header, `ready` at offset 32, descriptors at `64 + 16*slot`, slot
  count `2..8`, names beginning with the literal `Local\agwinterm-frame-` followed by 1..128
  characters of `[A-Za-z0-9._-]`, formats `132` or `32`. Every number in Task 1 is copied from
  the spec's tables, and Task 1's tests quote the spec's offsets back. Where the spec and this
  plan disagree, the spec wins and the plan is corrected.
- **Serialised, two slots.** The contract's one normative producer rule is that a slot must not
  be refilled until the reply for the frame that last used it has returned. With one frame in
  flight and the pipe already request/response, that rule holds by construction, and the test
  in Task 5 pins the construction. Pipelining is deferred (see Deferred): the contract names a
  torn frame as its failure mode, the engine's pipe client is one request per connection, and
  the round trip it would hide is 6.6 ms of which 5.5 ms is fixed cost inside agwinterm.
- **`seq` is monotonic for the life of the process, and a resize gets a fresh mapping-name
  suffix.** The host skips the pixel copy when `(id, name, seq)` repeats and rejects a `seq`
  that goes backwards; a mapping recreated under the same name is allowed only if the sequence
  continues. So a fresh suffix per incarnation, never a restarted counter.
- **Store `ready` before sending, with release semantics; never shrink or close the mapping
  while a request is outstanding.** Both are contract obligations, both are cheap, both get a
  test.
- **No edit to a vendored file.** `canvas.rs` is vendored; `tools/vendor-check` fails the build
  if a vendored line changes without a recorded disposition. Everything here lives in
  port-written files (`frame_shm.rs`, `frame_file.rs`, `agwinterm.rs`) and one new file.
- **Every `unsafe` block is documented.** `pixel-core` denies undocumented unsafe. The mapping
  is a handful of Win32 calls and one pointer-length view; each block says what invariant
  makes it sound.
- **Windows only, under `cfg(windows)`.** The unix build keeps compiling with the producer
  absent, as `terminal_windows.rs` already is.
- **Every wait is bounded.** The pipe already has a deadline
  (`07-as-built.md` § A control-pipe exchange has a deadline); the acceptance test uses
  `tools/lib/deadline.mjs`. No test in this plan may hang.
- **The file path is not touched except where the two share a seam.** `encode_png`,
  `write_frame`, the retention list and `pane-clear` ownership are untouched; the fast path
  is a second `publish` route selected before the encode, and `Transport::File` reaches the
  old code unchanged. `02-frame-budget.md`'s baseline must be reproducible after this plan.
- **Do not invent a spelling.** The design diagram in `00-port-brief.md:316` shows
  `Local\winterm-browser-<pid>-<id>`, written before the contract existed. The contract's
  prefix is what ships; Task 9 corrects the diagram to it.

## Development Approach

- **Testing approach**: tests are written with each task and verified **red before green** —
  the change is made, the test is shown to fail against the previous behaviour, then pass. Where
  a test cannot be red first (a new module with nothing to regress), a mutation is named in the
  task and shown to turn it red. This is the tree's convention; `06-acceptance.md` records it.
- Complete each task fully before starting the next; all tests must pass between tasks:
  `cargo nextest run --workspace` (from `engine/`), `node.exe --test "tools/*/*.test.mjs"`,
  `python tools/vendor-check/fmt-scope.py` and `clippy-scope.py` (0 port-line complaints).
  `cargo fmt --all --check` is red on this tree by design and is not the gate.
- Invoke `node.exe`, not `node` — the shell aliases the latter to `winpty`, which fails
  non-interactively.
- Small, focused changes. Update this plan when scope changes; add ➕ for discovered tasks,
  ⚠️ for blockers.

## Testing Strategy

- **Unit tests** in the crate, every task. The mapping is tested in-process: create it, open it
  by name with `OpenFileMappingW` from the same test, read the header and pixels back through
  the second view. That is the reader's view of the bytes without needing the reader.
- **A fake `ControlClient`** for the request tests (`frame_file.rs` already has the pattern:
  a client that records what it was sent and answers from a script).
- **One acceptance test against a live host** (`tools/acceptance/`), skipping with a stated
  reason when the pane's host lacks the verb — which is every released agwinterm today.
- **Measurement is a task, not a footnote**: Task 8 re-runs the budget procedure and rewrites
  the table.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): work inside this repository — code, tests, docs
- **Post-Completion** (no checkboxes): a host build to run against, the measurement on real
  hardware being published, and the release note

## Implementation Steps

### Task 1: The layout, as pure code — `frame_shm::layout`

The contract's header and slot arithmetic, with no Win32 in it, so it is testable on any
platform and reads like the spec's tables.

- [x] add a `layout` submodule to `engine/crates/pixel-core/src/frame_shm.rs` with named
      constants for every offset and value the spec fixes: `MAGIC = 0x46534741`, `VERSION = 1`,
      `HEADER_LEN = 256`, `READY_OFFSET = 32`, `DESCRIPTOR_OFFSET = 64`, `DESCRIPTOR_LEN = 16`,
      `SLOT_COUNT = 2`, `FORMAT_RGBA = 32`, `NAME_PREFIX = r"Local\agwinterm-frame-"`,
      `MAX_DIMENSION = 16384`, `MAX_NAME_SUFFIX = 128`
- [x] `Layout::for_frame(width, height) -> Layout` — `stride = width * 4`, `slot_stride` rounded
      up to a page (4096), `pixel_offset = HEADER_LEN`, `mapping_len = pixel_offset +
      slot_stride * SLOT_COUNT`; rejects `width`/`height` outside `1..=16384`
- [x] `Layout::write_header(&self, view: &mut [u8])` — magic, version, slotCount, flags 0,
      slotStride, pixelOffset, `ready = 0`, reserved zeroed, all little-endian
- [x] `Layout::descriptor(slot) -> Range<usize>` and `Layout::pixels(slot) -> Range<usize>`
      — where a slot's descriptor and its `height * stride` bytes live in the view
- [x] `slot_for(seq: u64) -> u32` = `seq % SLOT_COUNT`, and `mapping_name(pid, incarnation)
      -> String` producing `Local\agwinterm-frame-browser-<pid>-<incarnation>`, plus
      `is_valid_name(&str) -> bool` implementing the prefix and charset rule
- [x] write tests quoting the spec's offset table: a header written by `write_header` has
      `0x46534741` at 0, `1` at 4, `2` at 8, `0` at 12, `slot_stride` at 16, `256` at 24, `0` at
      32, and zeros through 63; descriptor `i` starts at `64 + 16*i`
- [x] write tests for `for_frame`: 1920×1080 gives stride 7680, both slots inside
      `mapping_len`, `pixels(1)` does not overlap `pixels(0)` or the header; `0` and `16385`
      are rejected on both axes
- [x] write tests for `is_valid_name`: the exact prefix is required and case-sensitive
      (`local\…` rejected), the suffix may not be empty, may not exceed 128, and rejects a
      backslash, a space and a unicode letter; `mapping_name(1234, 0)` passes
- [x] write the test for `slot_for`: `seq` 1..=8 map to 1,0,1,0,… (sequences start at 1)
- [x] run `cargo nextest run --workspace` — must pass before Task 2

### Task 2: The mapping — `frame_shm::Mapping` (Windows)

The Win32 half: a named mapping the host can open, created and torn down correctly.

- [x] enable the `Win32_System_Memory` and `Win32_Foundation` `windows-sys` features in the
      workspace `Cargo.toml` if not already present
- [x] `Mapping::create(layout: &Layout, name: &str) -> io::Result<Mapping>` under
      `cfg(windows)`: `CreateFileMappingW(INVALID_HANDLE_VALUE, null, PAGE_READWRITE, size, name)`,
      `MapViewOfFile(FILE_MAP_ALL_ACCESS)`, then `layout.write_header` into the view; refuse a
      name `is_valid_name` rejects before touching Win32; `ERROR_ALREADY_EXISTS` from
      `CreateFileMappingW` is an error here, not a reuse — a producer that finds its own name
      taken has a stale incarnation and must pick a fresh suffix
- [x] `Mapping::view(&mut self) -> &mut [u8]` over exactly `mapping_len` bytes, and
      `Mapping::name(&self)`; `Drop` calls `UnmapViewOfFile` then `CloseHandle`
- [x] document every `unsafe` block: the view is `mapping_len` bytes because that is the size
      passed to `CreateFileMappingW` and the length is never read from the header; the handle
      and view are owned by the struct and freed once
- [x] write the in-process round-trip test: create a mapping, open it by name with
      `OpenFileMappingW` + `MapViewOfFile` from the same test, assert the header bytes match
      what Task 1's test expects and that a byte written through the producer's view is read
      through the second view
- [x] write tests for the error paths: an invalid name is refused without a Win32 call (assert
      by name pattern, no mapping exists afterwards); creating the same name twice in one process
      fails with a message naming the name; after `Drop`, `OpenFileMappingW` by that name fails
- [x] run tests — must pass before Task 3

### Task 3: Publishing a frame into a slot — `Mapping::publish`

- [x] `Mapping::publish(&mut self, seq: u64, canvas: &Canvas) -> Published` — picks
      `slot_for(seq)`, writes the slot's descriptor (`width`, `height`, `stride`, `FORMAT_RGBA`),
      copies the canvas rows into the slot's pixel range (row by row, `width * 4` bytes each;
      the canvas stride and the slot stride are both `width * 4` here), then stores `seq` into
      `ready` with `Ordering::Release` through an `AtomicU64` at `READY_OFFSET` (aligned: 32 is
      8-byte aligned and the view is page-aligned); returns the slot, seq and descriptor for
      the request
- [x] refuse (return `Err`, publish nothing) a canvas whose dimensions do not match the
      `Layout` — that is the caller's cue to recreate (Task 4), never a partial write
- [x] assert the canvas byte order: a test canvas painted one known RGBA colour lands in the
      slot as those four bytes in that order. tiny-skia's premultiplied storage is identical
      for opaque pixels; the test paints an opaque colour and one with alpha 128 and documents
      what the second produces, so the plan's claim is checked rather than believed
- [x] write the ordering test: after `publish(seq)`, `ready` read with `Ordering::Acquire`
      equals `seq`, and the slot's descriptor is fully written before `ready` changes — assert
      by publishing into a mapping whose `ready` is read through the second view of Task 2's
      round-trip test
- [x] write the test for a mismatched canvas: nothing in the view changes, `ready` stays put
- [x] run tests — must pass before Task 4

### Task 4: The producer's lifecycle — `frame_shm::Producer`

Owns the mapping, the sequence counter and the incarnation; the only thing `frame_file.rs`
talks to.

- [ ] `Producer::new(env: &SessionEnv) -> Producer` with no mapping yet, `seq = 0`,
      `incarnation = 0`, `pid` from the process
- [ ] `Producer::publish(&mut self, canvas: &Canvas) -> io::Result<Published>` — bumps `seq`
      first (sequences start at 1); if there is no mapping or the canvas dimensions differ from
      the current layout, creates a new mapping under `mapping_name(pid, incarnation)` with
      `incarnation += 1` **and keeps `seq` monotonic across the switch**; then delegates to
      `Mapping::publish`
- [ ] the previous mapping is dropped only after the new one exists and only when no request
      is outstanding — with one frame in flight (Task 5) that is the moment `publish` is
      called, which is after the last reply returned; document this dependency where the drop
      happens
- [ ] `Producer::current_name(&self) -> Option<&str>` for the request and the logs
- [ ] write tests: three publishes at one size use one mapping and seqs 1, 2, 3 in slots
      1, 0, 1; a fourth at a new size creates a second mapping with a different suffix and
      seq 4 (not 1); the first mapping's name no longer opens after the switch; a publish
      that fails to create the mapping leaves `seq` un-bumped so the next attempt reuses it
- [ ] run tests — must pass before Task 5

### Task 5: The request and the fallback — in `frame_file.rs`

- [ ] `frameshm_args(name, published, span) -> String` beside `frame_args`, using
      `push_quoted`, producing the spec's JSON: `images: [{ id, name, slot, seq, width,
      height, stride, format, row, col, cols, rows }]` with `row`/`col` and the span exactly as
      `frame_args` sends them (the two verbs are siblings and the placement must not differ)
- [ ] add a `FramePublisher::publish_shm` route: when `transport` is `Auto` or `Shm` and the
      fast path has not been latched off, `producer.publish(canvas)` then
      `client.send(FRAMESHM_CMD, Some(&frameshm_args(..)))`, awaiting the `Reply` before
      returning — this await **is** the slot-reuse rule; leave a comment there that says so and
      points at the Task 5 test
- [ ] on `Reply::Err` where `is_unknown_command(msg, FRAMESHM_CMD)`: set a session latch
      `fast_path = Latched::Unavailable`, log once (through the same warning channel the
      existing `warnings_since` tests read), and send **this same frame** through the file
      path so nothing is dropped; every later frame takes the file path without asking again
- [ ] on any other `Reply::Err` (validation, no such pane): send this frame through the file
      path and log the host's message; count consecutive refusals and latch the fast path off
      after 3, with a log line saying which three; a success resets the count. A host that
      rejects the mapping is telling this producer something is wrong with it, and a producer
      that keeps re-sending a rejected frame at 26 fps is the failure mode to avoid
- [ ] `Transport::File` never constructs a `Producer`; `Transport::Shm` on a latched session
      logs `unavailable_reason` once per session — rewrite `unavailable_reason`'s text: the
      reason is now "the host answered unknown command", not "the layout is not published"
- [ ] `check_transmitted` applies to the shm reply exactly as to the file reply: `frame:0/0`
      is not a placement; a successful shm frame marks the pane (`mark_pane`) on the first
      accepted frame just as the file path does, since `pane-clear` ownership is about
      placements, not files
- [ ] write tests with the recording fake client: the exact JSON for a 1920×1080 frame at
      span (120, 30) with `id`, `slot`, `seq`, `stride 7680`, `format 32`; an `unknown command`
      reply latches, the same frame arrives as an `image.frame`, and the *next* frame sends
      no `image.frameshm` at all; a `no such pane` reply does not latch, and three in a row do;
      a success after two refusals resets the counter; `Transport::File` sends only
      `image.frame` and creates no mapping; the fake client asserts it never sees a second
      `image.frameshm` before it has answered the first (the slot-reuse rule, pinned)
- [ ] extend the three existing `warnings_since` tests so that `shm` on a host that lacks
      the verb warns exactly once, and `file` still never warns
- [ ] run tests — must pass before Task 6

### Task 6: Budget accounting and teardown

- [ ] extend `FrameCost` and the budget file with a `transport` column (`file`/`shm`) and,
      for shm frames, `copy_ms` where `encode_ms`/`write_ms` are zero; keep the file's header
      comment accurate — `02-frame-budget.md`'s numbers are read off this file and Task 8
      needs both transports distinguishable in one log
- [ ] on `FramePublisher::clear` and on drop: `image.clear` as today, then drop the
      `Producer` (which unmaps); the host's next open of that name fails and it reports an
      ordinary failure, which is the contract's expected end of a producer
- [ ] `TERMINAL_BROWSER_FRAME_TRANSPORT=file` on a session that had latched nothing still
      records `transport=file` rows identical in shape to today's, so the baseline procedure
      is unchanged
- [ ] write tests: a shm frame's budget row names `shm` and carries `copy_ms`; a file frame's
      row is byte-for-byte the previous shape plus the column; after `clear`, the mapping name
      no longer opens
- [ ] run tests — must pass before Task 7

### Task 7: Acceptance against a live host — `tools/acceptance/frameshm.test.mjs`

- [ ] probe the host from the pane's `AGWINTERM_PIPE` with an `image.frameshm` request that
      names an obviously invalid mapping; `unknown command` → `t.skip` with the reason "host
      lacks image.frameshm (agwinterm main ≥ 8230d0e required)"; a validation refusal → the
      verb exists, proceed
- [ ] with a capable host: launch the built browser on a fresh session as `pane-clear.test.mjs`
      does, load `tools/milestone/static-page.html`, wait (bounded) for the budget file to
      show at least three rows, assert they say `transport=shm`, and assert
      `session.text` / a screenshot-free check that the pane has a placement (whatever
      `06-acceptance.md`'s criteria used)
- [ ] the same with `TERMINAL_BROWSER_FRAME_TRANSPORT=file`: rows say `transport=file`, and
      the frame directory holds PNGs — the baseline path still works on a capable host
- [ ] the same with `TERMINAL_BROWSER_FRAME_TRANSPORT=shm` against the skip case: the browser
      still shows the page and the log carries `unavailable_reason` exactly once
- [ ] every wait through `tools/lib/deadline.mjs`; the test file passes on a host without the
      verb by skipping, and CI (which has no host) skips
- [ ] run the node suite — must pass before Task 8

### Task 8: Measure it

- [ ] re-run the procedure in `02-frame-budget.md` for both transports at the three pane sizes
      the table lists, on a host built from agwinterm `main ≥ 8230d0e`, and record the rows
      the budget file produced
- [ ] rewrite the table and the "what the fast path would delete" paragraph with what it did
      delete; keep the file-path rows as the baseline and say which agwinterm build the shm
      rows were taken on
- [ ] if the fast path does not beat the baseline at some size, say so with the numbers and
      do not adjust the plan to hide it; the design promised "a baseline to beat", not a win
- [ ] add a docs-check test that the budget table names both transports and that the
      agwinterm build it cites is a real commit (`git ls-remote` is not available in the
      test; a 7-hex-digit pattern is enough)
- [ ] run tests — must pass before Task 9

### Task 9: Verify acceptance criteria

- [ ] every Overview bullet holds: fast path on a capable host, file path latched on an
      incapable one with the same frame delivered, the three `TERMINAL_BROWSER_FRAME_TRANSPORT`
      values mean what they meant
- [ ] `cargo nextest run --workspace`, `node.exe --test "tools/*/*.test.mjs"`, `fmt-scope.py`
      and `clippy-scope.py` all green with 0 port-line complaints
- [ ] the unix build compiles (`cargo check` with the producer under `cfg(windows)`)
- [ ] `tools/vendor-check` reports no vendored-line change
- [ ] every `unsafe` block added has a `// SAFETY:` comment naming its invariant

### Task 10: [Final] Update documentation

- [ ] `frame_shm.rs` module doc: the fast path is here; what it does, what latches it off, and
      the one producer rule and how the code keeps it
- [ ] `frame_file.rs` module doc: this path is the fallback and the baseline, entered on a
      host without the verb or on `TERMINAL_BROWSER_FRAME_TRANSPORT=file`
- [ ] `07-as-built.md` § 1: rewrite "Why the fast path is not here" as "How the fast path is
      selected", keep "How to force either", and keep the transports table exactly the set
      `frame_shm.rs` parses (the docs-check test at `:190` reads it)
- [ ] `00-port-brief.md`: a dated "As built, 2026-09" callout after the 2026-08-28 host update
      saying the consumer shipped; correct the diagram's mapping name at `:316` to the
      contract's prefix
- [ ] `02-frame-budget.md`: already rewritten in Task 8; check its links
- [ ] `README.md`: the transport paragraph, and the host requirement for the fast path
- [ ] `UPSTREAM.md`: if any port-written file's divergence list changes (it should not — no
      vendored file is edited), say so; otherwise leave it
- [ ] run the docs-check suite — links and pinned claims — must pass

## Technical Details

**Mapping layout (contract v1, copied, not designed here):**

| offset | size | field |
|---|---|---|
| 0 | 4 | `magic` = `0x46534741` |
| 4 | 4 | `version` = `1` |
| 8 | 4 | `slotCount` = `2` |
| 12 | 4 | `flags` = `0` |
| 16 | 8 | `slotStride` (page-rounded `height * stride`) |
| 24 | 8 | `pixelOffset` = `256` |
| 32 | 8 | `ready` — the newest published `seq`, release-stored |
| 40 | 24 | reserved, zero |
| 64 + 16·slot | 16 | `width`, `height`, `stride`, `format` |

Slot `i` pixels at `pixelOffset + i * slotStride`, `height * stride` bytes.

**Name:** `Local\agwinterm-frame-browser-<pid>-<incarnation>`; a new incarnation on every
resize; `seq` never restarts within a process.

**Request (per frame):**

```json
{"cmd":"image.frameshm","target":"<pane>","args":{"images":[{"id":1,
 "name":"Local\\agwinterm-frame-browser-4812-0","slot":1,"seq":1,
 "width":1920,"height":1080,"stride":7680,"format":32,
 "row":0,"col":0,"cols":120,"rows":30}]}}
```

**Flow per frame:** compose canvas → `producer.publish` (write descriptor, copy rows,
release-store `ready`) → `send image.frameshm` → await reply → next frame. The await is the
slot-reuse rule.

**Fallback:** `unknown command` → latch file path for the session, resend this frame as
`image.frame`. Any other refusal → this frame as `image.frame`, count; three consecutive →
latch. `TERMINAL_BROWSER_FRAME_TRANSPORT=file` → never try; `=shm` → try, and explain once if
latched.

## Deferred

- **Pipelining** (up to 8 slots with per-slot reply tracking). The contract permits it and
  warns about it. Worth it only if Task 8 shows the round trip dominating after the encode and
  write are gone; the numbers say it should not (6.6 ms, of which 5.5 ms is fixed cost inside
  agwinterm and is agwinterm's to find).
- **Zero-copy from Electron's paint buffer.** The producer copies the composed canvas, which is
  the right seam: chrome, overlays and the compositor all live in the canvas. Writing Electron's
  BGRA straight into a slot would bypass all of them.
- **agliteterm.** It never implements the verb and is the standing example of the fallback
  host; nothing to do there.

## Post-Completion

**A host to run against.** The verb is on agwinterm `main` (`8230d0e`) and in no release as
of 2026-09-03. Task 7 and Task 8 need an agwinterm built from `main`; on the installed
release they skip and the budget shows only the file path. The next agwinterm release makes
the fast path light up for every user without a browser change.

**Publishing the measurement.** Task 8's numbers are taken on this machine; the design doc
should say so, as `02-frame-budget.md` already does for the baseline.

**Release note.** The browser's first release after this should say: frames go over shared
memory on agwinterm ≥ the release that carries `8230d0e`; on older hosts nothing changes.
