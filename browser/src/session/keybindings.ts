import type { EngineKeyEvent, KeyMods } from "pixel-react";

export type KeyBinding = KeyMods & { key: string };

/**
 * The chords that open find, devtools and the console.
 *
 * Windows gets a third answer rather than sharing Linux's, for the reason
 * [`zoomHeld`] and [`navigationArrow`] already name: `ENABLE_VIRTUAL_TERMINAL_INPUT`
 * encodes Ctrl only as the C0 bytes `0x01..=0x1a`, and **those carry no shift**
 * (`terminal.rs`'s `byte_key_event` sets `ctrl` and nothing else). So `ctrl+shift+f`
 * and `ctrl+f` arrive identically, as `0x06` with `shift` clear, and `matchesMods`
 * compares shift exactly — a `ctrl+shift+*` default could never match whatever the
 * user pressed. Ctrl+`i` is worse than unreachable: `0x09` is Tab.
 *
 *   - **find** is `ctrl+f`, which is the Windows browser convention anyway.
 *   - **devtools** is `f12`, which arrives as a `CSI …~` sequence and decodes
 *     intact. `session.tsx` already accepted a bare F12 as a fallback; this makes
 *     it the binding, so `--devtools-key`'s default and the menu label agree with
 *     the only key that works.
 *   - **console** stays `ctrl+alt+j`: an Alt chord is an Esc-prefixed byte, so
 *     `\x1b\x0a` decodes as ctrl+alt+j with both modifiers on it.
 *   - **palette** is unchanged; `ctrl+k` and `alt+k` both survive.
 */
export const defaultKeys =
  process.platform === "darwin"
    ? { palette: "super+p", find: "super+shift+f", devtools: "super+shift+i", console: "super+alt+j" }
    : process.platform === "win32"
      ? { palette: "ctrl+k alt+k", find: "ctrl+f", devtools: "f12", console: "ctrl+alt+j" }
      : { palette: "ctrl+k alt+k", find: "ctrl+shift+f", devtools: "ctrl+shift+i", console: "ctrl+alt+j" };

/**
 * Start/stop recording, and what the record bar tells the user to press.
 *
 * Alt on Windows, for the shift reason above plus one that makes the obvious
 * alternative wrong: `ctrl+shift+r` reaches `handleKey` as a plain `ctrl+r`, and
 * `session.tsx` checks the record key *before* the accelerators, so binding record
 * to a bare Ctrl+R would take Reload — the chord every Windows browser has — away
 * from it. Alt+`r` is an Esc-prefixed byte, decodes intact, and collides with
 * nothing: Alt is otherwise spoken for only by the zoom keys and the arrows.
 *
 * Left as it was on macOS and Linux, both of which can deliver what they bind.
 */
export const recordKeyLabel =
  process.platform === "darwin" ? "ctrl+r" : process.platform === "win32" ? "alt+r" : "ctrl+shift+r";

export function isRecordKey(event: EngineKeyEvent): boolean {
  if (event.key.toLowerCase() !== "r" || event.mods.super) return false;
  if (process.platform === "win32") {
    return event.mods.alt && !event.mods.ctrl && !event.mods.shift;
  }
  return (
    event.mods.ctrl && !event.mods.alt && event.mods.shift === (process.platform !== "darwin")
  );
}

/**
 * Finish a recording (as against taking one more snapshot), and its label.
 *
 * Enter is the key on every platform; the modifier is what differs. A Windows
 * console has no encoding for Ctrl+Enter that survives as *Enter* — conhost sends
 * `0x0a`, which is Ctrl+J — so `ctrl+enter` never reached `complete()` and a review
 * could be started and never ended: Enter fell through to `snapshot()`. Alt+Enter
 * is `\x1b\x0d`, which decodes as Enter with `alt` set.
 */
export const completeKeyLabel = process.platform === "win32" ? "alt+enter" : "ctrl+enter";

export function isCompleteKey(event: EngineKeyEvent): boolean {
  if (event.key !== "enter") return false;
  if (process.platform === "win32") return event.mods.alt || event.mods.ctrl || event.mods.super;
  return event.mods.ctrl || event.mods.super;
}

/**
 * The modifier that stands in for Cmd on this host.
 *
 * Windows has no Super to bind: agwinterm implements no kitty keyboard protocol,
 * so `leftsuper`/`rightsuper` never reach the engine and `mods.super` is never
 * set — a `cmd+p` chord could not match whatever the user pressed. Upstream's
 * substitute for a host with no Super is Alt (`session.tsx`'s `noSuper`), which
 * is wrong here for a different reason: Alt *is* a modifier Windows pages use,
 * and every accelerator this maps — new tab, address bar, reload, back, forward,
 * zoom — is Ctrl on Windows by convention.
 */
export const cmdModifier: "super" | "ctrl" =
  process.platform === "win32" ? "ctrl" : "super";

/**
 * Is the Cmd accelerator held? `noSuper` is the host's answer to "can you deliver
 * Super at all", which off Windows is what decides whether Alt stands in for it.
 *
 * Alt is deliberately not accepted where Ctrl is the accelerator: alt+t is not "new
 * tab" on Windows, and Alt is a modifier pages use in their own right. The chords a
 * console cannot spell with Ctrl are handled by [`zoomHeld`] and
 * [`navigationArrow`], which name the two exceptions rather than widening this one.
 */
export function cmdHeld(event: EngineKeyEvent, noSuper: boolean): boolean {
  if (cmdModifier === "ctrl") return event.mods.ctrl;
  return event.mods.super || (noSuper && event.mods.alt);
}

/**
 * Is the zoom accelerator held?
 *
 * Apart from the letters, a Windows console cannot deliver Ctrl at all.
 * `ENABLE_VIRTUAL_TERMINAL_INPUT` encodes Ctrl+a..z as the C0 bytes `0x01..=0x1a`
 * and has no encoding for anything else: Ctrl+`=` arrives as a plain `=` with no
 * modifier on it, and Ctrl+`-` as a plain `-`. So Ctrl+T, Ctrl+L, Ctrl+R, Ctrl+C
 * and Ctrl+Q reach the browser and the zoom chords — Ctrl with `=`, `+`, `-`, `_`
 * or `0` — cannot, however they are spelled. Zoom was unreachable.
 *
 * Alt chords are deliverable: an Esc-prefixed byte decodes as Alt+that-key
 * (`terminal.rs`), so Alt+`=` and Alt+`-` arrive intact. Accepted only for the zoom
 * keys, so Alt stays a page modifier everywhere else. Ctrl is still accepted, which
 * costs nothing and is what a host that grows a real keyboard protocol would send.
 */
export function zoomHeld(event: EngineKeyEvent, noSuper: boolean): boolean {
  if (cmdModifier === "ctrl") return event.mods.ctrl || event.mods.alt;
  return cmdHeld(event, noSuper);
}

/**
 * Back and forward, spelled the way a Windows console can deliver them.
 *
 * The bracket chords the other platforms use are unreachable here whatever the
 * accelerator: Ctrl+`[` is `0x1b`, which is Escape; Ctrl+`]` is `0x1d`, which
 * decodes as no key at all; and Alt+`[` / Alt+`]` are the CSI and OSC introducers,
 * so the decoder is waiting for the rest of a sequence rather than reporting a key.
 * Alt with an arrow has an encoding of its own — `CSI 1;3D` and `CSI 1;3C` — which
 * survives intact, and is what a Windows browser binds for this anyway.
 *
 * Only where Ctrl is the accelerator, so the hosts that can deliver the brackets
 * keep exactly the bindings they had.
 */
export function navigationArrow(event: EngineKeyEvent): "back" | "forward" | null {
  if (cmdModifier !== "ctrl") return null;
  if (!event.mods.alt || event.mods.ctrl || event.mods.super || event.mods.shift) return null;
  if (event.key === "left") return "back";
  if (event.key === "right") return "forward";
  return null;
}

/** Cmd, plus the platforms that also accept a bare Ctrl for navigation keys. */
export function accelHeld(event: EngineKeyEvent, noSuper: boolean): boolean {
  return cmdHeld(event, noSuper) || (process.platform === "linux" && event.mods.ctrl);
}

/**
 * Copy/cut/paste. Ctrl+shift+c is a terminal convention and Ctrl+alt+c is not a
 * clipboard key anywhere, so both are excluded where Ctrl is the accelerator.
 */
export function clipboardHeld(event: EngineKeyEvent, noSuper: boolean): boolean {
  const bareCtrl = event.mods.ctrl && !event.mods.shift && !event.mods.alt;
  if (cmdModifier === "ctrl") return bareCtrl;
  return cmdHeld(event, noSuper) || (process.platform === "linux" && bareCtrl);
}

export function parseKeyBindings(spec: string): KeyBinding[] {
  if (spec === "none") return [];
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const parts = chord.toLowerCase().split("+");
      const key = parts.pop() ?? "";
      return { ...parseMods(parts), key };
    });
}

export function matchesBinding(event: EngineKeyEvent, bindings: KeyBinding[]): boolean {
  return bindings.some(
    (binding) => event.key.toLowerCase() === binding.key && matchesMods(event, binding),
  );
}

export function listStep(event: EngineKeyEvent): 1 | -1 | null {
  if (event.key === "down" || (event.mods.ctrl && event.key === "n")) return 1;
  if (event.key === "up" || (event.mods.ctrl && event.key === "p")) return -1;
  return null;
}

export function bindingLabel(bindings: KeyBinding[]): string {
  const binding = bindings[0];
  if (!binding) return "";
  const superKey =
    process.platform === "darwin" ? "cmd+" : cmdModifier === "ctrl" ? "ctrl+" : "super+";
  const mods = `${binding.super ? superKey : ""}${binding.ctrl ? "ctrl+" : ""}${
    binding.alt ? "alt+" : ""
  }${binding.shift ? "shift+" : ""}`;
  return `${mods}${binding.key}`;
}

function parseMods(parts: string[]): KeyMods {
  const mods = { super: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    // A `--palette-key cmd+p` written for a Mac must still land on something a
    // Windows user can press; see `cmdModifier`.
    if (part === "cmd" || part === "super") mods[cmdModifier] = true;
    else if (part === "ctrl") mods.ctrl = true;
    else if (part === "alt" || part === "option") mods.alt = true;
    else if (part === "shift") mods.shift = true;
  }
  return mods;
}

function matchesMods(event: EngineKeyEvent, mods: KeyMods): boolean {
  return (
    event.mods.super === mods.super &&
    event.mods.ctrl === mods.ctrl &&
    event.mods.alt === mods.alt &&
    event.mods.shift === mods.shift
  );
}
