import net from "node:net";

import { endpointKind } from "pixel-store";

/** The most a single-line reply may grow to before the caller gives up on it. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/**
 * One request, one line, one reply, to a browser's control endpoint.
 *
 * The endpoint is a unix socket path on unix and a `\\.\pipe\…` name on Windows;
 * `net.connect` takes both through the same argument, so the protocol below is
 * untouched by the port. Only the diagnostics needed to change — "socket" is the
 * wrong noun for half the addresses this now sees.
 */
export function control(
  endpoint: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(endpoint);
    let buffer = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`control request timed out (${endpointKind(endpoint)} ${endpoint})`)),
      timeoutMs,
    );
    connection.setEncoding("utf8");
    connection.on("error", fail);
    // A peer that hangs up without answering has answered. Without this the caller
    // waited out the whole timeout for a browser that had already gone — and `ls`
    // asks every registered browser at once, so one dead endpoint held the command
    // up by the full deadline.
    connection.on("close", () =>
      fail(new Error(`the ${endpointKind(endpoint)} ${endpoint} closed without replying`)),
    );
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      // A reply is one line. A peer that streams without ever sending a newline
      // would otherwise grow this until the timeout, and on Windows the name is one
      // any local process can take (`store/src/endpoint.ts`), so the cost is worth
      // capping rather than trusting.
      if (buffer.length > MAX_REPLY_BYTES) {
        fail(new Error(`control reply exceeded ${MAX_REPLY_BYTES} bytes with no newline`));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        if (response.ok) resolve(response.data);
        else reject(new Error(response.error ?? "control request failed"));
      } catch (error) {
        reject(error);
      }
    });
    connection.write(`${JSON.stringify(request)}\n`);
  });
}
