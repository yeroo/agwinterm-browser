import { clipboard, nativeImage } from "electron";
import type { WebContents } from "electron";
import type { EngineKeyEvent, PastedImage, PointerEvent, WheelEvent } from "pixel-react";

export interface InputTarget {
  contents(): WebContents;
  scale(): number;
  /**
   * The page's size in CSS pixels, when the caller knows it. `pointer` clamps to
   * it, which matters only at the last row and column: the surface is
   * `round(cssExtent * scale)` device pixels wide, so a pointer on its final
   * device pixel divides back to `cssExtent` — one past the last addressable CSS
   * pixel — on any display scaled above 2. Optional so a target that does not
   * track its own size keeps the unclamped behaviour.
   */
  size?(): { width: number; height: number } | null;
  focus(): Promise<void> | void;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Whether the host reports key *releases*.
 *
 * Only the kitty keyboard protocol does; agwinterm does not implement it, and no
 * Windows console host does either, so on this port every key arrives as a press
 * and nothing ever arrives to close it. Chromium would then hold every key it was
 * ever sent down until the page lost focus — `keyup` never fires, and a page
 * watching for one (a shortcut released, a key held to pan) simply stops working.
 *
 * Defaults to `false`, which is the value that is *safe* when nothing sets it: a
 * synthesized release is harmless on a host that sends real ones — `sentKeys`
 * makes the real release a no-op — while a missing one is invisible until a page
 * misbehaves. Task 10 lost a day to a capability that defaulted to the convenient
 * value instead of the safe one.
 */
let keyReleasesReported = false;

export function setKeyReleaseReporting(reported: boolean) {
  keyReleasesReported = reported;
}

export function reportsKeyReleases() {
  return keyReleasesReported;
}

/**
 * Surface device pixels to page CSS pixels.
 *
 * `x` and `y` arrive from the engine already in the surface's device pixels — on
 * this port that is a cell coordinate multiplied by the pane's cell size at
 * `terminal_windows.rs`'s `mouse_position_px`, so the value names the *centre* of
 * a character cell and the pointer's resolution is one cell. `scale` is the
 * display's device-pixel ratio, the same number Chromium was handed as
 * `deviceScaleFactor`, so dividing by it lands in the page's own coordinates.
 */
export function pagePoint(
  x: number,
  y: number,
  scale: number,
  size?: { width: number; height: number } | null,
): { x: number; y: number } {
  // A zero or NaN scale would map the whole surface onto one point, or onto none.
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const axis = (value: number, extent: number | undefined) => {
    const at = Math.max(0, Math.round(value / factor));
    return extent && extent > 0 ? Math.min(at, extent - 1) : at;
  };
  return { x: axis(x, size?.width), y: axis(y, size?.height) };
}

type SendableInputEvent = Parameters<WebContents["sendInputEvent"]>[0];

export class PageInput {
  private readonly target: InputTarget;
  private lastX = 0;
  private lastY = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private pressed = new Set<"left" | "middle" | "right">();
  private click = { button: "none", at: 0, x: 0, y: 0, count: 0 };
  private activeClickCount = 1;
  private wheelRemainderX = 0;
  private wheelRemainderY = 0;
  private sentKeys = new Set<string>();
  private superHeld = false;
  private focusGate: Promise<void> | null = null;

  constructor(target: InputTarget) {
    this.target = target;
  }

  private syncFocus(): Promise<void> | null {
    const pending = this.target.focus();
    if (!pending) return this.focusGate;
    const gate = this.focusGate ? this.focusGate.then(() => pending) : pending;
    this.focusGate = gate;
    void gate.then(() => {
      if (this.focusGate === gate) this.focusGate = null;
    });
    return gate;
  }

  private send(event: SendableInputEvent) {
    const contents = this.target.contents();
    if (this.focusGate) void this.focusGate.then(() => contents.sendInputEvent(event));
    else contents.sendInputEvent(event);
  }

  releaseModifiers() {
    this.superHeld = false;
  }

  private rememberModifiers(event: EngineKeyEvent) {
    this.superHeld =
      event.key === "leftsuper" || event.key === "rightsuper"
        ? event.kind !== "release"
        : !!event.mods.super;
  }

  private pointerModifiers(mods: PointerEvent["mods"]) {
    return this.modifiers(this.superHeld && !mods.super ? { ...mods, super: true } : mods);
  }

  pointer(event: PointerEvent) {
    this.syncFocus();
    const { x, y } = pagePoint(event.x, event.y, this.target.scale(), this.target.size?.());
    this.lastX = x;
    this.lastY = y;
    const button = event.button === "none" ? undefined : event.button;
    if (event.kind === "down" && button) {
      this.pressed.add(button);
      this.activeClickCount = this.nextClickCount(button, x, y);
    }
    if (event.kind === "up" && button) this.pressed.delete(button);
    const modifiers = this.pointerModifiers(event.mods);
    for (const pressed of this.pressed) modifiers.push(`${pressed}buttondown`);
    this.send({
      type:
        event.kind === "down"
          ? "mouseDown"
          : event.kind === "up"
            ? "mouseUp"
            : "mouseMove",
      x,
      y,
      movementX: x - this.lastSentX,
      movementY: y - this.lastSentY,
      button,
      clickCount: event.kind === "move" ? 0 : this.activeClickCount,
      modifiers,
    });
    this.lastSentX = x;
    this.lastSentY = y;
  }

  wheel(event: WheelEvent) {
    this.syncFocus();
    if (event.mods.ctrl && event.precise) {
      this.pinch(event);
      return;
    }
    if (!event.precise) {
      this.wheelTick(event);
      return;
    }
    const scale = this.target.scale();
    this.wheelRemainderX += -event.deltaX / scale;
    this.wheelRemainderY += -event.deltaY / scale;
    const deltaX = wholeDelta(this.wheelRemainderX);
    const deltaY = wholeDelta(this.wheelRemainderY);
    this.wheelRemainderX -= deltaX;
    this.wheelRemainderY -= deltaY;
    if (deltaX === 0 && deltaY === 0) return;
    this.send({
      type: "mouseWheel",
      x: this.lastX,
      y: this.lastY,
      deltaX,
      deltaY,
      wheelTicksX: deltaX / 40,
      wheelTicksY: deltaY / 40,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
      modifiers: this.pointerModifiers(event.mods),
    });
  }


  private wheelTick(event: WheelEvent) {
    const ticksX = -Math.sign(event.deltaX);
    const ticksY = -Math.sign(event.deltaY);
    if (ticksX === 0 && ticksY === 0) return;
    const step = WHEEL_DETENT_PX;
    this.send({
      type: "mouseWheel",
      x: this.lastX,
      y: this.lastY,
      deltaX: ticksX * step,
      deltaY: ticksY * step,
      wheelTicksX: ticksX,
      wheelTicksY: ticksY,
      hasPreciseScrollingDeltas: false,
      canScroll: true,
      modifiers: this.pointerModifiers(event.mods),
    });
  }

  private pinch(event: WheelEvent) {
    const pinchScale = 1 - event.deltaY / 100;
    if (pinchScale <= 0) return;
    this.send({
      type: "mouseWheel",
      x: this.lastX,
      y: this.lastY,
      deltaX: 0,
      deltaY: 100 * Math.log(pinchScale),
      wheelTicksX: 0,
      wheelTicksY: pinchScale > 1 ? 1 : -1,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
      modifiers: ["ctrl"],
    });
  }

  key(event: EngineKeyEvent) {
    this.rememberModifiers(event);
    if (event.key === "enter") {
      void this.dispatchEnter(event).catch(() => { });
      return;
    }
    const commands = process.platform === "darwin" ? editingCommands(event) : null;
    if (commands) {
      void this.dispatchEditing(event, commands).catch(() => { });
      return;
    }
    const keyCode = electronKey(event.key);
    if (event.kind === "release") {
      if (!keyCode) return;
      this.sendKeyUp(event.key, keyCode, this.sideModifiers(event.key, this.modifiers(event.mods)));
      return;
    }
    this.syncFocus();
    if (!keyCode) {
      if (event.text) {
        this.target.contents().insertText(event.text);
      }
      return;
    }
    const modifiers = this.sideModifiers(event.key, this.modifiers(event.mods));
    const down = [...modifiers!];
    if (event.kind === "repeat") down.push("isautorepeat");
    this.sentKeys.add(event.key);
    this.send({ type: "rawKeyDown", keyCode, modifiers: down });
    const printable = !!event.text && !event.mods.ctrl && !event.mods.super && !event.mods.alt;
    if (printable) {
      this.send({ type: "char", keyCode: event.text!, modifiers: down });
    }
    // Nothing will arrive to close this key, so close it here. The modifiers are
    // the press's, not an empty set: shift is still down while `a` comes back up.
    if (!keyReleasesReported) this.sendKeyUp(event.key, keyCode, modifiers);
  }

  /** `left`/`right` tells Chromium which of a paired modifier key was used. */
  private sideModifiers(key: string, modifiers: Electron.InputEvent["modifiers"]) {
    if (key.startsWith("left")) modifiers!.push("left");
    if (key.startsWith("right")) modifiers!.push("right");
    return modifiers;
  }

  /** Releases a key once; a second call for the same press does nothing. */
  private sendKeyUp(
    key: string,
    keyCode: string,
    modifiers: Electron.InputEvent["modifiers"],
  ) {
    if (!this.sentKeys.delete(key)) return;
    this.send({ type: "keyUp", keyCode, modifiers });
  }

  paste(text: string) {
    clipboard.writeText(text);
    if (process.platform === "darwin") {
      void this.dispatchPaste().catch(() => { });
      return;
    }
    this.syncFocus();
    this.target.contents().paste();
  }


  async selectionText(): Promise<string> {
    for (const frame of this.target.contents().mainFrame.framesInSubtree) {
      const text = await frame.executeJavaScript(SELECTION_SNIPPET).catch(() => "");
      if (typeof text === "string" && text) return text;
    }
    return "";
  }

  pasteImage(image: PastedImage) {
    this.syncFocus();
    switch (image.source) {
      case "clipboard":
        this.target.contents().paste();
        return;
      case "osc":
      case "file": {
        const staged = nativeImage.createFromPath(image.path);
        if (staged.isEmpty()) return;
        clipboard.writeImage(staged);
        this.target.contents().paste();
        return;
      }
    }
  }

  releaseKeys() {
    for (const key of this.sentKeys) {
      const keyCode = electronKey(key);
      if (!keyCode) continue;
      this.send({ type: "keyUp", keyCode, modifiers: this.sideModifiers(key, []) });
    }
    this.sentKeys.clear();
  }
  /**
   * 
   * why are we hard coding huerestics for vscode web??
   * 
   */

  private async dispatchEnter(event: EngineKeyEvent) {
    const base = {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: cdpModifiers(event.mods),
    };
    if (event.kind === "release") {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    await this.syncFocus();
    await this.target.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: event.kind === "repeat",
    });
    if (!event.mods.ctrl && !event.mods.super && !event.mods.alt) {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    }
    // Enter takes the CDP path on every platform, so it needs the same synthetic
    // release the `sendInputEvent` path above gets.
    if (!keyReleasesReported) {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
  }

  private async dispatchPaste() {
    const base = {
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 4,
    };
    await this.syncFocus();
    await this.target.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      commands: ["Paste"],
    });
    await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  private async dispatchEditing(event: EngineKeyEvent, commands: string[]) {
    const info = EDITING_KEY_INFO[event.key];
    if (!info) return;
    const base = {
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers: cdpModifiers(event.mods),
    };
    if (event.kind === "release") {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    await this.syncFocus();
    await this.target.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: event.kind === "repeat",
      commands,
    });
    // The same synthetic release `dispatchEnter` and the `sendInputEvent` path
    // already send. Without it these keys -- backspace, the four arrows and the
    // ctrl/cmd editing combos -- are the one route left that opens a press and
    // never closes it, on exactly the hosts that report no releases of their own.
    if (!keyReleasesReported) {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
  }

  private nextClickCount(button: "left" | "middle" | "right", x: number, y: number) {
    const now = Date.now();
    const close = Math.abs(x - this.click.x) <= 4 && Math.abs(y - this.click.y) <= 4;
    const count = this.click.button === button && now - this.click.at <= 500 && close
      ? Math.min(this.click.count + 1, 3)
      : 1;
    this.click = { button, at: now, x, y, count };
    return count;
  }

  private modifiers(mods: { shift: boolean; alt: boolean; ctrl: boolean; super: boolean }) {
    const result: Electron.InputEvent["modifiers"] = [];
    if (mods.shift) result.push("shift");
    if (mods.alt) result.push("alt");
    if (mods.ctrl) result.push("ctrl");
    if (mods.super) result.push("meta");
    return result;
  }
}

const SELECTION_SNIPPET = `(() => {
  const el = document.activeElement;
  try {
    if (el && "selectionStart" in el && el.selectionStart !== el.selectionEnd) {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
  } catch {}
  return String(getSelection() ?? "");
})()`;


const WHEEL_DETENT_PX = process.platform === "darwin" ? 40 : 120;

function wholeDelta(value: number) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function cdpModifiers(mods: { shift: boolean; alt: boolean; ctrl: boolean; super: boolean }) {
  return (
    (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.super ? 4 : 0) | (mods.shift ? 8 : 0)
  );
}

const EDITING_KEY_INFO: Record<string, { key: string; code: string; keyCode: number }> = {
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  a: { key: "a", code: "KeyA", keyCode: 65 },
  b: { key: "b", code: "KeyB", keyCode: 66 },
  c: { key: "c", code: "KeyC", keyCode: 67 },
  d: { key: "d", code: "KeyD", keyCode: 68 },
  e: { key: "e", code: "KeyE", keyCode: 69 },
  f: { key: "f", code: "KeyF", keyCode: 70 },
  k: { key: "k", code: "KeyK", keyCode: 75 },
  u: { key: "u", code: "KeyU", keyCode: 85 },
  w: { key: "w", code: "KeyW", keyCode: 87 },
  x: { key: "x", code: "KeyX", keyCode: 88 },
  z: { key: "z", code: "KeyZ", keyCode: 90 },
};

function editingCommands(event: EngineKeyEvent): string[] | null {
  const { key, mods } = event;
  if (mods.ctrl) return controlEditingCommands(event);
  const select = mods.shift ? "AndModifySelection" : "";
  if (key === "backspace") {
    if (mods.super) return ["deleteToBeginningOfLine"];
    if (mods.alt) return ["deleteWordBackward"];
    return null;
  }
  if (key === "b" && mods.alt && !mods.super) return [`moveWordLeft${select}`];
  if (key === "f" && mods.alt && !mods.super) return [`moveWordRight${select}`];
  if (key === "left" || key === "right") {
    const end = key === "left" ? "moveToLeftEndOfLine" : "moveToRightEndOfLine";
    const word = key === "left" ? "moveWordLeft" : "moveWordRight";
    if (mods.super) return [`${end}${select}`];
    if (mods.alt) return [`${word}${select}`];
    return null;
  }
  if (key === "up" || key === "down") {
    const edge = key === "up" ? "moveToBeginningOfDocument" : "moveToEndOfDocument";
    if (mods.super && !mods.alt) return [`${edge}${select}`];
    return null;
  }
  if (mods.super && !mods.alt && !mods.shift && key === "a") return ["selectAll"];
  if (mods.super && !mods.alt && key === "z") return [mods.shift ? "redo" : "undo"];
  if (mods.super && !mods.alt && !mods.shift && key === "c") return ["Copy"];
  if (mods.super && !mods.alt && !mods.shift && key === "x") return ["Cut"];
  return null;
}

// fixme this is left over and shouldn't exist 
function controlEditingCommands(event: EngineKeyEvent): string[] | null {
  const { key, mods } = event;
  if (mods.super || mods.alt) return null;
  const select = mods.shift ? "AndModifySelection" : "";
  switch (key) {
    case "a":
      return [`moveToLeftEndOfLine${select}`];
    case "e":
      return [`moveToRightEndOfLine${select}`];
    case "b":
      return [`moveLeft${select}`];
    case "f":
      return [`moveRight${select}`];
    case "d":
      return ["deleteForward"];
    case "k":
      return ["deleteToEndOfLine"];
    case "w":
      return ["deleteWordBackward"];
    case "u":
      return ["deleteToBeginningOfLine"];
    default:
      return null;
  }
}

export function electronKey(key: string) {
  const special: Record<string, string> = {
    enter: "return",
    backspace: "backspace",
    delete: "delete",
    escape: "escape",
    tab: "tab",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    home: "home",
    end: "end",
    insert: "insert",
    pageup: "pageup",
    pagedown: "pagedown",
    leftshift: "shift",
    leftcontrol: "control",
    leftalt: "alt",
    leftsuper: "meta",
    rightshift: "shift",
    rightcontrol: "control",
    rightalt: "alt",
    rightsuper: "meta",
  };
  if (key === "unknown") return null;
  return special[key] ?? key;
}
