// A pipe server that stops accepting — a browser too busy to answer.
//
// `endpoint.test.mjs` needs a *live* endpoint whose connect does not complete, and
// that cannot be staged in one process: libuv arms its pipe instances with overlapped
// `ConnectNamedPipe`, so the kernel completes a client's `CreateFile` whether or not
// the server's loop ever gets round to the accept. What stalls a connect is the
// server having no instance left to give — which happens once the queued ones are
// spoken for and the loop that would create more is not running.
//
// So: listen, say so, and then block. `argv[2]` is the endpoint, `argv[3]` how many
// milliseconds to hold the loop for.

import net from "node:net";

const endpoint = process.argv[2];
const holdMs = Number(process.argv[3] ?? 4_000);

const server = net.createServer(() => {});
server.on("error", () => process.exit(1));
server.listen(endpoint, () => {
  process.stdout.write("ready\n");
  const until = Date.now() + holdMs;
  while (Date.now() < until) {}
  server.close();
  process.exit(0);
});
