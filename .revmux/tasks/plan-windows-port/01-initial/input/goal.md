# What I want out of this triage

These plans will be executed autonomously by ralphex, task by task, with little human steering
between tasks. So the cost of a wrong assumption is not an argument — it is a long run that builds
the wrong thing and looks like it succeeded.

Weigh points by that standard.

## What I most want to know

1. **Is the central architectural bet sound?** The bet is that keeping `pixel-core` and replacing
   only its tty layer is cheaper than dropping it. That bet rests on a count of unix-API references
   per module. A reference count is a proxy for portability, and proxies fail. Is there a module in
   the "19 with zero hits" column that will not in fact build or behave on Windows — a path
   assumption, a threading assumption, a font or clipboard dependency, an unwrap on something
   unix-shaped? `arboard` and `fontdue` are worth a look specifically.

2. **Does the plan's task ordering actually work?** Each task claims to be independently completable
   with tests passing before the next begins. Find the task that cannot be, or whose tests cannot
   mean anything until a later task lands.

3. **Is the first-frame-on-screen milestone (Task 8) reachable where it sits?** It is placed before
   interactive input and before the shm path deliberately. If something earlier is missing for it to
   work, that is the single most valuable thing to find.

4. **Is the two-repo split right, and is the contract between them actually pinned?** The Windows
   plan's Task 10 depends on a spec file the agwinterm plan produces at its Task 1. Is that enough,
   or is there a shape mismatch already visible between what one side promises and the other assumes?

5. **What has been assumed about Windows and not checked?** ConPTY behaviour, console VT input,
   Electron OSR on Windows, named pipes, `MemoryMappedFile` lifetime. The brief distinguishes what
   was measured from what was reasoned; tell me where that line is in the wrong place.

## Framing already settled — argue against it only with evidence, not preference

- **WSL is out of scope.** A point recommending WSL is not useful; a point showing the native path
  cannot work is extremely useful.
- **Stock Electron only.** No patched Electron build for Windows.
- **agwinterm is the only target terminal.** Portability to Windows Terminal is not a goal.
- Regular testing (code first, then tests), not TDD. That was chosen deliberately for work whose
  interfaces are discovered by making them run.

## What I do not need

- Judgements about document structure, heading style or checkbox formatting.
- Restatements of the plan back to me.
- A verdict on whether to proceed. I will decide that; give me the reasoning.
