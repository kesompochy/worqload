import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeRpcMessage,
  createRpcMessageParser,
  LspClient,
  type LspServerProcess,
} from "./lsp-client";

// --- framing ---






// --- client over a fake server process ---

function makeFakeProcess(): {
  proc: LspServerProcess;
  pushStdout(bytes: Uint8Array): void;
  endStdout(): void;
  exit(): void;
  stdinWrites: Uint8Array[];
} {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const stdout = (async function* () {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as Uint8Array;
        continue;
      }
      if (ended) return;
      await new Promise<void>(r => { wake = r; });
    }
  })();
  let resolveExited!: () => void;
  const exited = new Promise<void>(r => { resolveExited = r; });
  const stdinWrites: Uint8Array[] = [];
  const tick = () => { const w = wake; wake = null; w?.(); };
  return {
    proc: {
      writeStdin(bytes) { stdinWrites.push(bytes); },
      stdout,
      exited,
      kill() { ended = true; tick(); resolveExited(); },
    },
    pushStdout(bytes) { queue.push(bytes); tick(); },
    endStdout() { ended = true; tick(); },
    exit() { ended = true; tick(); resolveExited(); },
    stdinWrites,
  };
}

const flush = () => new Promise<void>(r => setTimeout(r, 2));

// Decode every JSON-RPC message the client has written to stdin so far.
// biome-ignore lint/suspicious/noExplicitAny: test helper inspecting arbitrary JSON-RPC payloads
type RpcMessage = any;
function sentMessages(writes: Uint8Array[]): RpcMessage[] {
  const parser = createRpcMessageParser();
  const out: RpcMessage[] = [];
  for (const w of writes) out.push(...parser.feed(w));
  return out;
}

async function completeHandshake(fp: ReturnType<typeof makeFakeProcess>): Promise<void> {
  await flush();
  const init = sentMessages(fp.stdinWrites).find(m => m.method === "initialize");
  expect(init).toBeDefined();
  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } }));
  await flush();
  await flush();
}





test("definition opens the queried document (didOpen with its content) before asking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worqload-lsp-"));
  const filePath = join(dir, "a.ts");
  writeFileSync(filePath, "export const v = 1;\n");
  try {
    const fp = makeFakeProcess();
    const client = new LspClient(fp.proc, dir);
    const p = client.definition(filePath, { line: 0, character: 13 });
    await completeHandshake(fp);
    const sent = sentMessages(fp.stdinWrites);
    const didOpen = sent.find(m => m.method === "textDocument/didOpen");
    expect(didOpen.params.textDocument).toEqual({
      uri: `file://${filePath}`,
      languageId: "typescript",
      version: 1,
      text: "export const v = 1;\n",
    });
    const defReq = sent.find(m => m.method === "textDocument/definition");
    fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: defReq.id, result: null }));
    expect(await p).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});




