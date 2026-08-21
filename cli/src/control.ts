import net from "node:net";

import { endpointKind } from "pixel-store";

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
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`control request timed out (${endpointKind(endpoint)} ${endpoint})`));
    }, timeoutMs);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
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
