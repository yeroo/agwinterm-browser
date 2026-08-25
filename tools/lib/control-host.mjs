// A stand-in for agwinterm's control server, on a real named pipe.
//
// Two suites drive the CLI's `image.clear` against a host: `tools/cli/pane-clear.test.mjs`
// calls the library functions in-process, and `tools/acceptance/pane-clear.test.mjs`
// runs the built CLI as a child process. Both make the same claim — a JSON line
// arrives on a pipe, or does not — so both need the same server, and a second copy
// of it would be a second place for "what the host does when it stops answering" to
// drift. It lives here for the reason `deadline.mjs` does.
//
// It is a real `net.Server` on a real pipe rather than a mock, because what is under
// test is bytes on a pipe: a mock of the host would be a mock of the thing being
// checked.

import net from "node:net";

import { closeServer, listen } from "./deadline.mjs";

/** The prefix every local named pipe address carries. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A control server on a real pipe, recording the lines it is sent.
 *
 * `answer: null` accepts the line and never replies, which is the host that has
 * stopped answering — the case the client's timeout exists for.
 */
export function hostOn(name, answer = '{"ok":true,"result":"cleared"}') {
  const endpoint = PIPE_PREFIX + name;
  const lines = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (answer !== null) socket.write(`${answer}\n`);
      }
    });
    socket.on("error", () => {});
  });
  // Both halves are bounded. The bind can fail (a name a previous run left held),
  // and the close waits on every connection the client opened — the `answer: null`
  // host below never ends one, so an unawaited `close()` would leave the pipe up
  // for the rest of the run.
  const listening = listen(server, endpoint);
  return { endpoint, name, lines, server, listening, close: () => closeServer(server) };
}
