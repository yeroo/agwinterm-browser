# Shared-memory frame command (`image.frameshm`)

## Overview

Add a control-pipe command that accepts browser-rate BGRA frames through a shared memory mapping
instead of through files, so a producer can drive a pane at video rates without a PNG encode or a
disk round-trip on every frame.

The consumer is [winterm-browser](file:///C:/Users/boris/source/winterm-browser), a Windows-native
port of terminal-browser that renders Chromium into an agwinterm pane. Its design brief is
`C:\Users\boris\source\winterm-browser\docs\design\00-port-brief.md`. That project is blocked on
this command, and this plan defines the contract it codes against — so the wire shape here is the
deliverable, not just the implementation.

**Problem it solves.** `image.frame` (`ControlServer.cs:249`) is already a frame path: it takes an
`images[]` array, content-signature-caches each id to skip re-transmits, reads pixel bytes off the
render lock, and swaps placements under a microsecond-scale lock. But every image arrives as a
`path`, so a 30fps full-pane producer must PNG-encode and write a file 30 times a second and
agwinterm must read it back. For a document viewer like docxy that is fine. For a browser it is not.

**Why this is worth doing beyond the browser.** The expensive part of `image.frame` is not the
placement machinery, which is already good — it is the format and the transport. Anything that
generates pixels rather than loading them (a video preview, a plot that animates, a remote frame
buffer) hits the same wall.

## Context (from discovery)

- `src/Agwinterm.Pty/ControlServer.cs:249` — `image.frame` dispatch; `HandleImageFrame` at ~line 425
  is the model to follow: phase 1 resolves placements and owns pixel bytes **off** the render lock,
  phase 2 takes a brief lock for dictionary/list swaps only.
- `src/Agwinterm.Core/KittyGraphics.cs` — `KittyFormat { Rgb = 24, Rgba = 32, Png = 100 }`,
  `KittyImage(Id, Format, Width, Height, Data)`, `ImagePlacement(ImageId, Row, Col, Cols, Rows,
  SrcX, SrcY, SrcW, SrcH)`.
- `src/Agwinterm.Pty/ISession.cs:64,66` — `Inject(ReadOnlySpan<byte>)` and
  `MutateLocked(Action<ITerminalCore>)`; both take the render lock internally.
- `tests/Agwinterm.Pty.Tests/ControlServerTests.cs` and `ControlApiTests.cs` — where control-verb
  tests live.
- `tests/conformance/control-api.json` — **shared with agliteterm**; the same spec runs in both
  repositories' CI. See the constraint below.

## Constraints

- **Do not add `image.frameshm` to `tests/conformance/control-api.json`.** That file is a contract
  agliteterm must also satisfy, and adding a verb there fails agliteterm's build for a command it
  does not implement. Test this verb in agwinterm's own xunit suites only. If it should later become
  part of the shared dialect, that is a separate decision made with agliteterm in hand.
- **Frames must never tear.** A producer writing while the renderer reads is the default failure
  mode of any shared buffer; the design must make a torn read impossible, not unlikely.
- **A dead or lying producer must not take the terminal down.** The name, dimensions, stride and
  offsets all arrive from another process and every one of them is untrusted input into a pointer
  computation. Validate against the actual mapped view length before any copy.
- **`ControlServer` int args must be JSON numbers, not strings** — `GetInt` throws
  `"requires an element of type 'Number'"` otherwise. The ctl serializes `cargs` by type, so parse
  with `int.TryParse` on the CLI side.
- Backward compatibility: `image.frame` keeps working unchanged. This is an additional verb.
- Build discipline (these have cost hours before): close the running dev instance before building;
  build `src/Agwinterm.Win32` **explicitly** so its copy of `Agwinterm.Pty.dll` is not stale;
  a plain solution build outputs to a *different* directory than a project build.
- Test against an isolated instance: a Debug build auto-uses instance id `agwinterm-dev` with its own
  data dir and pipe. Drive it with `agwintermctl --pipe agwinterm-dev`. **Never** run against the
  real `agwinterm` pipe or data dir.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for the code changes in that task.
  - unit tests for new and modified methods, listed as separate checklist items
  - both success and error scenarios — for this plan the error scenarios are the point, since
    most of the risk is malformed input from another process
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Maintain backward compatibility with `image.frame`.

## Testing Strategy

- **Unit tests**: required in every task. `tests/Agwinterm.Pty.Tests/` for the control verb and its
  validation; `tests/Agwinterm.Core.Tests/` for any `KittyGraphics` change.
- **Integration test**: a test that creates a real `MemoryMappedFile`, publishes a frame through the
  control server, and asserts the emulator holds the expected `KittyImage` and `ImagePlacement`.
- **No e2e/UI test in this plan.** Visual confirmation arrives with the winterm-browser plan, which
  is the real consumer. Do not build a throwaway pixel producer just to look at it.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update the plan if implementation deviates from the original scope.

## Implementation Steps

### Task 1: Define the shared-frame wire format and header

- [ ] add `docs/specs/image-frameshm.md` documenting the mapping layout and the JSON args, so the
      consuming project has a written contract rather than a reading of the source
- [ ] define the mapping layout in `src/Agwinterm.Pty/ShmFrameLayout.cs`: a fixed-size header
      followed by two pixel slots, so the producer writes one slot while the renderer reads the other
- [ ] header carries at minimum: a magic value, a layout version, slot count, slot byte stride,
      per-slot `(width, height, stride, format)` and a monotonically increasing `ready` sequence
      number identifying the slot that is complete
- [ ] define the JSON args shape: `{"images":[{"id":N,"name":"Local\\...","slot":N,"seq":N,
      "width":N,"height":N,"stride":N,"format":N,"row":N,"col":N,"cols":N,"rows":N}]}` — every
      numeric a JSON number, `name` the mapping name, ids reusing `image.frame` semantics
- [ ] write tests for header encode/decode round-trip
- [ ] write tests for rejecting a bad magic, an unknown version and an out-of-range slot index
- [ ] run tests — must pass before Task 2

### Task 2: Add BGRA as an internal pixel format

- [ ] add `Bgra` to `KittyFormat` in `src/Agwinterm.Core/KittyGraphics.cs` with a value **outside**
      the Kitty wire range (24/32/100 are the protocol's; pick e.g. 132) so it can never be produced
      by parsing a real APC sequence
- [ ] document in the enum why it exists: Direct2D wants `B8G8R8A8_UNORM` and Electron hands out
      BGRA, so carrying BGRA end to end removes a full-frame channel swizzle per frame
- [ ] handle the new format in the renderer's texture upload path, taking the no-swizzle route
- [ ] verify the emulator's APC parser cannot yield the new value — add a guard if it can
- [ ] write tests for the renderer path selecting no-swizzle for `Bgra` and swizzle for `Rgba`
- [ ] write a test asserting a crafted APC sequence declaring `f=132` does not produce `Bgra`
- [ ] run tests — must pass before Task 3

### Task 3: Open and validate a producer's mapping safely

- [ ] add `src/Agwinterm.Pty/ShmFrameReader.cs` that opens a named mapping with
      `MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read)`
- [ ] validate before any copy: view length is at least header size; `stride >= width * 4`;
      `height * stride` fits within the slot; the slot's byte range lies inside the view; `width`
      and `height` are positive and within a sane maximum
- [ ] restrict accepted names to a fixed prefix in the `Local\` namespace so a request cannot name
      an arbitrary existing object
- [ ] return a typed failure rather than throwing for every rejection, so the control server answers
      `{"ok":false,...}` instead of tearing down the connection
- [ ] treat a vanished mapping (producer died) as an ordinary failure, not an exception path
- [ ] write tests for each rejection: short view, `stride < width*4`, slot out of range, negative and
      overflowing dimensions, name outside the allowed prefix, nonexistent mapping
- [ ] write a test for the success case reading known bytes out of a real `MemoryMappedFile`
- [ ] run tests — must pass before Task 4

### Task 4: Wire `image.frameshm` into the control server

- [ ] add `"image.frameshm" => HandleImageFrameShm(s, args)` to the session-targeted dispatch in
      `src/Agwinterm.Pty/ControlServer.cs`
- [ ] implement `HandleImageFrameShm` mirroring `HandleImageFrame`'s two-phase structure: resolve
      placements and copy pixel bytes out of the mapping **off** the render lock, then take the
      brief lock for `ClearPlacements` and the placement/image swap
- [ ] skip re-transmitting a slot whose `(id, seq)` matches what was last accepted, the shm analogue
      of `image.frame`'s content-signature cache
- [ ] return the same result shape as `image.frame` (count, transmits, bytes read) so a caller can
      tell whether a frame actually moved
- [ ] write tests for a single frame producing the expected `KittyImage` and `ImagePlacement`
- [ ] write tests for the `(id, seq)` cache skipping a repeat and accepting a bumped seq
- [ ] write tests for malformed args: missing `images`, missing `name`, a string where a number
      belongs, an id that is not an int
- [ ] run tests — must pass before Task 5

### Task 5: Expose the verb on `agwintermctl`

- [ ] add the CLI surface in `src/Agwinterm.Ctl` alongside the existing `image` verbs
- [ ] parse numeric options with `int.TryParse` and place **ints** into `cargs`, never strings
- [ ] keep the CLI shape close to `image frame` so the two read as siblings
- [ ] write tests for arg parsing, especially that numerics serialize as JSON numbers
- [ ] run tests — must pass before Task 6

### Task 6: Prove it end to end against a live dev instance

- [ ] close any running dev instance, then `dotnet build src/Agwinterm.Win32` explicitly
- [ ] launch the Debug build (instance id `agwinterm-dev`, its own pipe and data dir)
- [ ] write an integration test that creates a mapping, fills a slot with a recognisable pattern,
      publishes it via the control pipe and asserts the emulator's image and placement state
- [ ] confirm `--pipe agwinterm-dev tree` shows the fresh dev tree, not the real sessions, before
      trusting any result
- [ ] measure and record: frames per second sustained, and bytes copied per frame, for a full-pane
      1920x1080 BGRA frame — the winterm-browser plan needs this number to size its frame budget
- [ ] write the measurement into `docs/specs/image-frameshm.md`
- [ ] run tests — must pass before Task 7

### Task 7: Verify acceptance criteria

- [ ] verify `image.frame` still behaves exactly as before (no regression in the file path)
- [ ] verify every rejection in Task 3 answers `{"ok":false,...}` and leaves the session usable
- [ ] verify a producer killed mid-frame does not wedge or crash the terminal
- [ ] confirm `tests/conformance/control-api.json` is **unchanged**
- [ ] run the full unit test suite
- [ ] run the linter — all issues fixed
- [ ] verify test coverage meets the project standard

### Task 8: [Final] Update documentation

- [ ] update `docs/agterm-gap-analysis.md:41`, whose "Image protocols / graphics" line currently
      reads *Partial* and describes only the out-of-band file path
- [ ] update the agent skill's image section (`src/Agwinterm.Pty/AgentSkill.cs`) if the verb should
      be discoverable to agents
- [ ] cross-link `docs/specs/image-frameshm.md` from the winterm-browser brief

## Technical Details

**Why two slots and a sequence number.** The producer owns one slot at a time and the renderer reads
the other. The producer fills a slot completely, then publishes by writing `ready = seq` with a
release barrier; the renderer reads `ready` with an acquire barrier and copies from the slot it
names. A frame in flight is therefore never the frame being read, and no lock is shared across the
process boundary — a producer that dies mid-write leaves a half-written slot that is simply never
published.

**Why copy at all.** The renderer could map the producer's pixels directly, but then a producer that
exits invalidates a view the renderer is still using. Copying under a brief lock costs one memcpy and
removes an entire class of lifetime bug. A genuine zero-copy path — Electron's D3D11 shared texture
handle opened directly by Direct2D — is a later, separate piece of work and is explicitly out of
scope here.

**Format.** BGRA end to end. Electron's `paint` gives BGRA, Direct2D wants `B8G8R8A8_UNORM`, so a
swizzle would be pure loss at both ends.

## Post-Completion

**Manual verification**:
- Sustained-load behaviour: leave a producer running at full rate for a long stretch and watch for
  drift in memory and handles.
- Behaviour when the pane is not visible — agwinterm gates repaint on visibility, so a background
  pane should stop costing anything.

**External system updates**:
- winterm-browser codes against `docs/specs/image-frameshm.md`; a change to the layout after that
  project starts is a breaking change for it.
- agliteterm speaks the agwintermctl dialect via the shared conformance contract. This verb is
  deliberately outside it; revisit only with agliteterm in hand.
