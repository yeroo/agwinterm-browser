import fs from "node:fs";
import net from "node:net";

import { callerTty } from "pixel-terminals";
import { removeInstance, upsertInstance } from "pixel-store";
import type { InstanceRow } from "pixel-store";

import type { BrowserState } from "./page/types";
import {
  INSTANCES_DIR,
  endpointKind,
  instanceEndpoint,
  isPipeEndpoint,
  reclaimEndpoint,
  removeEndpoint,
} from "pixel-store";

export interface Where {
  terminal: string | null;
  tab: string | null;
  pane: string | null;
}

export interface ControlHost {
  key: string;
  tty: string | null;
  where(): Promise<Where>;
  splitDir: InstanceRow["splitDir"];
  parentTty: string | null;
  state(): BrowserState;
  openTab(url?: string, cwd?: string): number;
  activateTab(id: number): boolean;
  closeTab(id: number): boolean;
  tabs(): unknown;
  targets(): Promise<unknown>;
  viewport(): { width: number; height: number } | null;
}

/**
 * The most one request line may grow to before the connection is dropped. The
 * mirror of `cli/src/control.ts`'s `MAX_REPLY_BYTES`, which caps the same protocol
 * from the other end.
 */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

interface ControlRequest {
  cmd: string;
  url?: string;
  cwd?: string;
  tab?: number;
}

export class Registry {
  private readonly host: ControlHost;
  private readonly endpoint: string;
  private readonly tty: string | null;
  private readonly startedAt = Date.now();
  private cdpPort: number | null = null;
  private server: net.Server | null = null;
  private disposed = false;
  /** Whether `listen` has succeeded. Until it has, there is nothing to advertise. */
  private listening = false;

  /**
   * Resolves once the endpoint is listening, or once binding it has failed.
   *
   * Nothing in the browser awaits this: the session carries on while the pipe
   * comes up. It exists because binding became asynchronous (see `bind`) and
   * "the control channel is ready" stopped being true at the end of the
   * constructor, which is something a caller, and a test, has to be able to wait
   * for rather than guess at.
   */
  readonly ready: Promise<void>;

  constructor(host: ControlHost) {
    this.host = host;
    this.tty = host.tty ?? callerTty().path;
    this.endpoint = instanceEndpoint(host.key);
    // Nothing in the browser awaits `ready`, so a rejection here has no handler
    // and Node ends the process on it — skipping `dispose`, which is what deletes
    // the `instances` row and (on unix) the socket file, and on Windows what lets
    // the engine's `Drop` clear the pane. Upstream bound synchronously in this
    // constructor, so the same throw reached `createSession`'s `.catch` and became
    // an orderly `shutdown(1)`. Binding became asynchronous; the handling has to
    // follow it. The outcome is the one `bind` already chose for `EADDRINUSE` —
    // the browser runs, unadvertised, and says so.
    this.ready = this.bind().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `terminal-browser: could not set up the ${endpointKind(this.endpoint)} ` +
          `${this.endpoint} (${message}). This browser is not reachable from the ` +
          `command line, and is not being advertised as though it were.\n`,
      );
    });
  }

  /**
   * Takes the name, then listens on it, then publishes the row — in that order.
   *
   * Upstream did all three at once and read none of the answers, which on unix was
   * nearly safe: the unlink before `listen` made a failed bind hard to reach. On
   * Windows there is nothing to unlink (`store/src/endpoint.ts`), so `EADDRINUSE`
   * is reachable for the first time — and publishing through it would write an
   * endpoint nobody is listening on into the `instances` row, which every `ls`,
   * `new-tab` and `action` then dials. A browser advertising a control channel it
   * does not have is worse than one advertising none, because the row is what tells
   * the CLI there is something to talk to.
   *
   * `reclaimEndpoint` rather than a bare `removeEndpoint`: it probes before it
   * unlinks, so a *live* socket keeps its name instead of being detached from the
   * server still holding it. That probe is what makes this asynchronous, and why
   * the row appears a few milliseconds after the browser starts rather than
   * instantly.
   */
  private async bind(): Promise<void> {
    // A pipe name has no directory to create and nothing to unlink; a socket path
    // has both. `reclaimEndpoint` already knows which it was handed, but the mkdir
    // is meaningful only in the filesystem case, so that one is asked directly.
    if (!isPipeEndpoint(this.endpoint)) fs.mkdirSync(INSTANCES_DIR, { recursive: true });
    await reclaimEndpoint(this.endpoint);
    if (this.disposed) return;
    const server = net.createServer((connection) => this.serve(connection));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.on("error", (error: NodeJS.ErrnoException) => {
        if (this.listening || this.disposed) return;
        process.stderr.write(
          `terminal-browser: could not listen on the ${endpointKind(this.endpoint)} ` +
            `${this.endpoint} (${error.message}). This browser is not reachable from ` +
            `the command line, and is not being advertised as though it were.\n`,
        );
        resolve();
      });
      server.once("listening", () => {
        this.listening = true;
        this.write();
        resolve();
      });
      // A `dispose` that lands while `listen` is still in flight closes the server
      // without ever emitting `listening` or `error`, so this is what keeps `ready`
      // from being a promise that never settles.
      server.once("close", resolve);
      server.listen(this.endpoint);
    });
  }

  setCdpPort(port: number | null) {
    this.cdpPort = port;
    this.write();
  }

  update() {
    this.write();
  }

  record(): InstanceRow {
    return {
      ...this.host.state(),
      tabs: this.host.tabs(),
      viewport: this.host.viewport(),
      pid: process.pid,
      key: this.host.key,
      tty: this.tty,
      splitDir: this.host.splitDir,
      parentTty: this.host.parentTty,
      endpoint: this.endpoint,
      cdpPort: this.cdpPort,
      startedAt: this.startedAt,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.listening = false;
    this.server?.close();
    this.server = null;
    void removeInstance(this.host.key).catch(() => {});
    removeEndpoint(this.endpoint);
  }

  private write() {
    if (this.disposed || !this.listening) return;
    void upsertInstance(this.record()).catch(() => {});
  }

  private serve(connection: net.Socket) {
    let buffer = "";
    let answered = false;
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk: string) => {
      // `connection.end` half-closes: the readable side stays open, so a peer that
      // keeps sending gets this handler again. Without the flag the second line was
      // dispatched — a second `open-tab`, with real side effects — and the second
      // `connection.end` threw `ERR_STREAM_WRITE_AFTER_END` into the error handler
      // above, where it was swallowed. On Windows the endpoint is a name any local
      // process can dial, so "one request per connection" has to be enforced rather
      // than assumed.
      if (answered) return;
      buffer += chunk;
      // A request is one line. `cli/src/control.ts` caps its side of this protocol
      // for the reason that applies with more force here: on Windows the endpoint
      // is a name any local process can dial, and this is the *server* — a peer
      // that streams without ever sending a newline would otherwise grow this
      // string inside the browser until the process ran out of memory.
      if (buffer.length > MAX_REQUEST_BYTES) {
        connection.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      // One request per connection. Whatever followed the newline is dropped along
      // with the buffer: there is no second answer to give it, and holding it would
      // only keep the bytes alive for a handler that now returns early.
      answered = true;
      buffer = "";
      void this.handle(line)
        .then((data) => {
          connection.end(`${JSON.stringify({ ok: true, data })}\n`);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          connection.end(`${JSON.stringify({ ok: false, error: message })}\n`);
        });
    });
  }

  private async handle(line: string): Promise<unknown> {
    const request = JSON.parse(line) as ControlRequest;
    switch (request.cmd) {
      case "state":
        return this.record();
      case "where":
        return this.host.where();
      case "open-tab": {
        const id = this.host.openTab(request.url, request.cwd);
        return { ...this.record(), openedTab: id, tabs: await this.host.targets() };
      }
      case "targets":
        return { ...this.record(), tabs: await this.host.targets() };
      case "activate-tab": {
        if (request.tab === undefined) throw new Error("activate-tab needs a tab id");
        if (!this.host.activateTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      case "close-tab": {
        if (request.tab === undefined) throw new Error("close-tab needs a tab id");
        if (!this.host.closeTab(request.tab)) throw new Error(`no tab ${request.tab}`);
        return { ...this.record(), tabs: await this.host.targets() };
      }
      default:
        throw new Error(`unknown command: ${request.cmd}`);
    }
  }
}
