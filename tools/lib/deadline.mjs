// "How long is this test willing to wait, and for what?"
//
// Several suites here drive real named pipes and real sockets, because what they
// check is behavioural — a server that binds, a client that connects, a name that
// frees itself. Every one of those is a wait on the operating system, and an
// operating system under test can decline to answer:
//
//   - `server.listen(name, cb)` never calls `cb` when the bind fails; the failure
//     arrives on the `error` event instead, and a promise that only subscribed to
//     the callback waits for a resolution that will never come;
//   - `server.close(cb)` waits for every accepted connection to finish closing, so
//     one socket the test forgot — or one the peer is holding open — keeps the
//     callback pending;
//   - a connect against a pipe whose server accepted and then stalled produces no
//     event at all.
//
// `tools/cli/registry.test.mjs` did exactly this on 2026-08-21: it awaited a pipe
// connection with no deadline of any kind, hung, and took the whole `pnpm test`
// run down with it — three `node` processes still wedged eighteen hours later.
// `--test-timeout` in the `test` script is the backstop for that, but a backstop
// reports only "this test file ran out of time". These helpers are the other half:
// each wait says what it was waiting for, so the failure names the pipe rather
// than the file.
//
// Every function here rejects rather than hanging. None of them swallows the
// underlying error — a bind that fails with `EADDRINUSE` still reports
// `EADDRINUSE`, not a timeout.

/** How long any single wait here gets when the caller does not say. */
export const DEFAULT_DEADLINE_MS = 5000;

/**
 * Rejects with a message naming `what` if `promise` has not settled in `ms`.
 *
 * The timer is cleared on either outcome, so a bounded wait never holds the event
 * loop open past its own resolution — which would turn a helper meant to stop
 * hangs into a source of them.
 */
export function withDeadline(promise, what, ms = DEFAULT_DEADLINE_MS) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Binds `server` to `endpoint` and resolves it once it is listening.
 *
 * Subscribes to `error` as well as to `listening`: a bind that fails is the case
 * the callback form of `listen` cannot report, and is what turns a name collision
 * between two suites into a hang instead of a message.
 */
export function listen(server, endpoint, ms = DEFAULT_DEADLINE_MS) {
  const bound = new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
  server.listen(endpoint);
  return withDeadline(bound, `${endpoint} to start listening`, ms);
}

/**
 * Closes `server` and resolves once it has stopped listening.
 *
 * `close` waits on every connection the server accepted, so this destroys them
 * first. Without that, one socket the test left open — or one a peer is holding —
 * keeps the callback pending forever, and teardown becomes the hang.
 */
export function closeServer(server, ms = DEFAULT_DEADLINE_MS) {
  const closed = new Promise((resolve) => server.close(resolve));
  // Node 18.2+; on older runtimes the connections simply stay up and the deadline
  // reports it rather than the run hanging.
  server.closeAllConnections?.();
  return withDeadline(closed, "the server to close", ms);
}

/**
 * Resolves with the first `event` emitted by `emitter`, or rejects on its `error`.
 *
 * `what` is what the caller is really waiting for — "the busy server to listen",
 * not "data" — because that is the sentence a failure should print.
 */
export function onceWithin(emitter, event, what, ms = DEFAULT_DEADLINE_MS) {
  const seen = new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
  return withDeadline(seen, what, ms);
}

/**
 * Resolves once `predicate()` holds, and rejects at the deadline rather than
 * spinning forever.
 *
 * The wait with no event behind it. A process a job object is tearing down does not
 * die on the same tick its parent does, and a lock file removed on the way out has
 * no watcher worth the complexity — so the answer is polled. It belongs here for the
 * same reason everything else does: every wait in this tree says what it was waiting
 * for and is bounded.
 *
 * The predicate runs before the first sleep, which is what guarantees it is consulted
 * at all: without it, an `ms` shorter than the caller's own setup rejects on the
 * `left <= 0` check having never once asked the question. Most callers here are waiting
 * on something at least a turn of the loop away and answer false the first time; the
 * one that can already hold — `!stillRunning(pid)` after a synchronous `taskkill /F` —
 * then costs no `every` at all. After that each sleep is capped to the time left,
 * because an uncapped `every` overruns the deadline in both directions: with
 * `ms = 50, every = 100` a never-settling predicate used to reject at ~100ms, and one
 * that only became true at 75ms was *accepted* at ~100ms — a wait silently honouring a
 * bound it had already missed. Capped, the last poll lands on the deadline and neither
 * happens.
 */
export async function settlesWithin(predicate, what, ms = DEFAULT_DEADLINE_MS, every = 25) {
  const until = Date.now() + ms;
  if (predicate()) return;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(every, left)));
    if (predicate()) return;
  }
}

/**
 * Runs `after`-hook teardown that must happen whether or not the test passed.
 *
 * Each step is awaited independently and its failure reported rather than thrown,
 * so one server that will not close cannot skip the cleanup of the next. Returns
 * the errors it swallowed, which lets a caller assert on them if it cares.
 */
export async function teardown(...steps) {
  const failures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
