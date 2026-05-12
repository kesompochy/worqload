// A minimal Language Server Protocol client: drives a language server child
// process over JSON-RPC (Content-Length framed) on its stdio, exposing just
// what worqload's code navigation needs — the initialize handshake, then
// `textDocument/definition` and `textDocument/references`. This is the transport
// the "language server extensions" (see code-nav.ts) plug into; one server is
// launched per worktree and torn down when idle.

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}

// ---- JSON-RPC framing (pure, so it can be unit-tested without a real process) ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRpcMessage(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const framed = new Uint8Array(header.length + body.length);
  framed.set(header, 0);
  framed.set(body, header.length);
  return framed;
}

// Incremental parser: feed it stdout chunks, get back the complete JSON-RPC
// messages that have arrived so far. Leftover bytes are retained for the next feed.
export function createRpcMessageParser(): { feed(chunk: Uint8Array): unknown[] } {
  let buffer = new Uint8Array(0);
  const append = (chunk: Uint8Array): void => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.length);
    buffer = merged;
  };
  const headerSeparatorIndex = (): number => {
    for (let i = 0; i + 3 < buffer.length; i++) {
      if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
    }
    return -1;
  };
  return {
    feed(chunk) {
      append(chunk);
      const messages: unknown[] = [];
      for (;;) {
        const sep = headerSeparatorIndex();
        if (sep === -1) break;
        const headerText = decoder.decode(buffer.slice(0, sep));
        const match = /content-length:\s*(\d+)/i.exec(headerText);
        const bodyStart = sep + 4;
        if (!match) {
          // Malformed header — drop it and resync at the next message.
          buffer = buffer.slice(bodyStart);
          continue;
        }
        const length = Number(match[1]);
        if (buffer.length < bodyStart + length) break; // body not fully arrived yet
        const bodyBytes = buffer.slice(bodyStart, bodyStart + length);
        buffer = buffer.slice(bodyStart + length);
        try {
          messages.push(JSON.parse(decoder.decode(bodyBytes)));
        } catch {
          // Skip an undecodable frame rather than wedging the stream.
        }
      }
      return messages;
    },
  };
}

// ---- process abstraction ----

// The bits of a spawned language server the client needs. `spawnLspServerProcess`
// implements it over Bun.spawn; tests substitute a fake.
export interface LspServerProcess {
  writeStdin(bytes: Uint8Array): void;
  stdout: AsyncIterable<Uint8Array>;
  exited: Promise<unknown>;
  kill(): void;
}

export function spawnLspServerProcess(command: string, args: string[], cwd: string): LspServerProcess {
  const proc = Bun.spawn([command, ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    writeStdin(bytes) {
      // Bun's stdin FileSink: write is synchronous-ish; flush so the server sees it promptly.
      proc.stdin.write(bytes);
      proc.stdin.flush();
    },
    stdout: proc.stdout as AsyncIterable<Uint8Array>,
    exited: proc.exited,
    kill() {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    },
  };
}

// ---- the client ----

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class LspClient {
  private readonly proc: LspServerProcess;
  private readonly rootPath: string;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly parser = createRpcMessageParser();
  private initialized: Promise<void> | null = null;
  private closed = false;

  constructor(proc: LspServerProcess, rootPath: string) {
    this.proc = proc;
    this.rootPath = rootPath;
    this.pumpStdout();
    void this.proc.exited.then(() => this.handleExit());
  }

  private async pumpStdout(): Promise<void> {
    try {
      for await (const chunk of this.proc.stdout) {
        for (const message of this.parser.feed(chunk)) this.handleMessage(message);
      }
    } catch {
      // stream ended/erred — handleExit cleans up pending requests
    }
  }

  private handleMessage(message: unknown): void {
    const m = message as { id?: number; result?: unknown; error?: { message?: string } };
    if (typeof m.id !== "number") return; // server request or notification — ignored
    const pending = this.pending.get(m.id);
    if (!pending) return;
    this.pending.delete(m.id);
    clearTimeout(pending.timer);
    if (m.error) pending.reject(new Error(m.error.message ?? "LSP error"));
    else pending.resolve(m.result);
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("language server exited"));
    }
    this.pending.clear();
  }

  private send(message: object): void {
    if (this.closed) throw new Error("language server is not running");
    this.proc.writeStdin(encodeRpcMessage(message));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private fileUri(absPath: string): string {
    return `file://${absPath}`;
  }

  // Lazily run the initialize / initialized handshake; idempotent.
  async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.request("initialize", {
          processId: typeof process !== "undefined" ? process.pid : null,
          rootUri: this.fileUri(this.rootPath),
          capabilities: {
            textDocument: {
              definition: { linkSupport: true },
              references: {},
            },
          },
        });
        this.notify("initialized", {});
      })();
    }
    return this.initialized;
  }

  async definition(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    await this.ensureInitialized();
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: this.fileUri(absPath) },
      position,
    });
    return normalizeLocations(result);
  }

  async references(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    await this.ensureInitialized();
    const result = await this.request("textDocument/references", {
      textDocument: { uri: this.fileUri(absPath) },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // best effort
    }
    this.proc.kill();
    this.handleExit();
  }
}

// `textDocument/definition` may answer with a single Location, a Location[], or
// LocationLink[] (which carries `targetUri`/`targetRange` instead). Flatten all
// shapes to Location[].
function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const item of items) {
    const o = item as { uri?: string; range?: LspLocation["range"]; targetUri?: string; targetRange?: LspLocation["range"] };
    const uri = o.uri ?? o.targetUri;
    const range = o.range ?? o.targetRange;
    if (typeof uri === "string" && range && range.start) out.push({ uri, range });
  }
  return out;
}
