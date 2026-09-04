// Where the engine's warnings go when nobody has the devtools open.
//
// `pixel-core` logs through `logging::warn` into a ring the engine drains into
// `log` events, and `pixel-react`'s `createRoot` pushes those into `engineLogs`
// (`engine/packages/pixel-react/src/index.ts`, `case "log"`) — a store whose only
// reader is the devtools log panel. The foreground shape runs with devtools off
// (`session.tsx`, for the reason its comment gives), so on Windows every warning the
// port's Rust emits was reaching a buffer nothing ever read. The one this was found
// on: `TERMINAL_BROWSER_FRAME_TRANSPORT=shm` on a host without `image.frameshm`
// earns a once-per-session explanation (`Transport::unavailable_reason`), and
// `tools/acceptance/frameshm.test.mjs` has to be able to see it — it is the whole
// evidence that the fallback said why.
//
// So this forwards the store's `warn` and `error` rows to a writer, one line per
// occurrence. The caller decides where the lines go; `foreground.ts` gives it fd 2,
// which under the CLI is the log file `openInForeground` opened rather than the pane.
//
// Kept import-free and given the store as an argument, so it can be tested with a
// hand-rolled store and no Electron, no built engine and no `pixel-react`.

/** The shape of one row of `engineLogs.store`, as much of it as this needs. */
export interface EngineLogRow {
  id: number;
  level: string;
  target: string;
  text: string;
  /**
   * `createLogStore` folds a message identical to the previous row into that row
   * and bumps this, rather than appending — so "said twice" is one row at `2`.
   */
  count: number;
}

/** The subset of `createLogStore()`'s result this reads. */
export interface EngineLogSource {
  store: {
    get(): { rows: EngineLogRow[] };
    subscribe(listener: () => void): () => void;
  };
}

/** The levels worth a line in a file nobody is watching. */
export const FORWARDED_LEVELS: ReadonlySet<string> = new Set(["warn", "error"]);

/** One occurrence, as a line. Greppable by target, which the Rust side names. */
export function formatEngineLog(row: Pick<EngineLogRow, "level" | "target" | "text">): string {
  return `engine ${row.level} ${row.target}: ${row.text}\n`;
}

/**
 * Writes every `warn`/`error` occurrence in `logs` to `write`, now and as they
 * arrive, and returns the unsubscribe.
 *
 * Each occurrence is written once. The store only ever changes its *last* row — a
 * message identical to it is folded in by bumping `count`; anything else is a new
 * row with the next id — and drops rows from the front, so the whole of "what has
 * gone out" is the last row's id and how many of its `count` were written. A row
 * with a smaller id was the last row once and went out in full then, or was never
 * the last row and so never grew; either way it is done. A fold onto the last row
 * writes the line again rather than losing the repeat — a warning the engine said
 * twice is two lines, which is what lets a reader assert "exactly once". Rows
 * already in the store when this is installed are written too; the store starts
 * empty and the engine starts after `runForeground` installs this, so in practice
 * that is nothing, and replaying is the choice that cannot lose a line. Nothing
 * here grows with the session.
 */
export function forwardEngineWarnings(
  logs: EngineLogSource,
  write: (line: string) => void,
): () => void {
  let lastId = 0;
  let lastCount = 0;
  const drain = () => {
    const rows = logs.store.get().rows;
    for (const row of rows) {
      if (row.id < lastId) continue;
      const before = row.id === lastId ? lastCount : 0;
      if (FORWARDED_LEVELS.has(row.level)) {
        for (let n = before; n < row.count; n += 1) write(formatEngineLog(row));
      }
    }
    const last = rows[rows.length - 1];
    if (last) {
      lastId = last.id;
      lastCount = last.count;
    }
  };
  drain();
  return logs.store.subscribe(drain);
}
