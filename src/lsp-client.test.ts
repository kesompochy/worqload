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

test("encodeRpcMessage frames a message with a Content-Length header", () => {
  const bytes = encodeRpcMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  const text = new TextDecoder().decode(bytes);
  const json = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  expect(text).toBe(`Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`);
});

test("createRpcMessageParser decodes a whole framed message", () => {
  const parser = createRpcMessageParser();
  expect(parser.feed(encodeRpcMessage({ id: 7, result: "ok" }))).toEqual([{ id: 7, result: "ok" }]);
});

test("createRpcMessageParser reassembles a message split across chunks", () => {
  const parser = createRpcMessageParser();
  const framed = encodeRpcMessage({ id: 1, result: { a: 1, b: "two" } });
  expect(parser.feed(framed.slice(0, 10))).toEqual([]);
  expect(parser.feed(framed.slice(10, 25))).toEqual([]);
  expect(parser.feed(framed.slice(25))).toEqual([{ id: 1, result: { a: 1, b: "two" } }]);
});

test("createRpcMessageParser yields multiple messages arriving in one chunk", () => {
  const parser = createRpcMessageParser();
  const a = encodeRpcMessage({ id: 1, result: "a" });
  const b = encodeRpcMessage({ id: 2, result: "b" });
  const both = new Uint8Array(a.length + b.length);
  both.set(a, 0);
  both.set(b, a.length);
  expect(parser.feed(both)).toEqual([{ id: 1, result: "a" }, { id: 2, result: "b" }]);
});

test("createRpcMessageParser resyncs past a header with no Content-Length", () => {
  const parser = createRpcMessageParser();
  const garbage = new TextEncoder().encode("X-Bogus: 1\r\n\r\n");
  const good = encodeRpcMessage({ id: 9, result: "recovered" });
  const merged = new Uint8Array(garbage.length + good.length);
  merged.set(garbage, 0);
  merged.set(good, garbage.length);
  expect(parser.feed(merged)).toEqual([{ id: 9, result: "recovered" }]);
});

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

test("LspClient runs the initialize handshake (with rootUri) then resolves textDocument/definition", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/work/tree");
  const defPromise = client.definition("/work/tree/a.ts", { line: 2, character: 4 });

  await flush();
  const init = sentMessages(fp.stdinWrites).find(m => m.method === "initialize");
  expect(init.params.rootUri).toBe("file:///work/tree");

  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } }));
  await flush();
  await flush();

  const sent = sentMessages(fp.stdinWrites);
  expect(sent.some(m => m.method === "initialized")).toBe(true);
  const defReq = sent.find(m => m.method === "textDocument/definition");
  expect(defReq.params).toEqual({ textDocument: { uri: "file:///work/tree/a.ts" }, position: { line: 2, character: 4 } });

  fp.pushStdout(encodeRpcMessage({
    jsonrpc: "2.0",
    id: defReq.id,
    result: { uri: "file:///work/tree/b.ts", range: { start: { line: 9, character: 1 }, end: { line: 9, character: 6 } } },
  }));
  expect(await defPromise).toEqual([
    { uri: "file:///work/tree/b.ts", range: { start: { line: 9, character: 1 }, end: { line: 9, character: 6 } } },
  ]);
});

test("definition normalizes a LocationLink (targetUri/targetRange) result", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.definition("/r/a.ts", { line: 0, character: 0 });
  await completeHandshake(fp);
  const defReq = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/definition");
  fp.pushStdout(encodeRpcMessage({
    jsonrpc: "2.0",
    id: defReq.id,
    result: [{ targetUri: "file:///r/c.ts", targetRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } } }],
  }));
  expect(await p).toEqual([{ uri: "file:///r/c.ts", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } } }]);
});

test("definition returns [] for a null result", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.definition("/r/a.ts", { line: 0, character: 0 });
  await completeHandshake(fp);
  const defReq = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/definition");
  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: defReq.id, result: null }));
  expect(await p).toEqual([]);
});

test("references sends includeDeclaration and flattens the Location[] result", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.references("/r/a.ts", { line: 5, character: 7 });
  await completeHandshake(fp);
  const refReq = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/references");
  expect(refReq.params.context).toEqual({ includeDeclaration: true });
  fp.pushStdout(encodeRpcMessage({
    jsonrpc: "2.0",
    id: refReq.id,
    result: [
      { uri: "file:///r/a.ts", range: { start: { line: 5, character: 7 }, end: { line: 5, character: 10 } } },
      { uri: "file:///r/b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
    ],
  }));
  expect((await p).map(l => l.uri)).toEqual(["file:///r/a.ts", "file:///r/b.ts"]);
});

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

test("a pending request rejects when the language server exits", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.definition("/r/a.ts", { line: 0, character: 0 });
  await flush();
  fp.exit();
  await expect(p).rejects.toThrow(/exited/);
});

test("documentSymbol flattens a hierarchical DocumentSymbol[] result", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.documentSymbol("/r/a.ts");
  await completeHandshake(fp);
  const req = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/documentSymbol");
  expect(req.params).toEqual({ textDocument: { uri: "file:///r/a.ts" } });
  const range = (l: number) => ({ start: { line: l, character: 0 }, end: { line: l, character: 5 } });
  fp.pushStdout(encodeRpcMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: [
      { name: "Klass", kind: 5, range: range(0), selectionRange: range(0), children: [
        { name: "method", kind: 6, range: range(2), selectionRange: range(2) },
      ] },
      { name: "topFn", kind: 12, range: range(8), selectionRange: range(8) },
    ],
  }));
  const symbols = await p;
  expect(symbols.map(s => s.name).sort()).toEqual(["Klass", "method", "topFn"]);
  expect(symbols.find(s => s.name === "method")?.kind).toBe(6);
});

test("documentSymbol normalizes a flat SymbolInformation[] result", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const p = client.documentSymbol("/r/a.ts");
  await completeHandshake(fp);
  const req = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/documentSymbol");
  const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } };
  fp.pushStdout(encodeRpcMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: [{ name: "fn", kind: 12, location: { uri: "file:///r/a.ts", range } }],
  }));
  expect((await p)[0]).toEqual({ name: "fn", kind: 12, range, selectionRange: range });
});

test("prepareCallHierarchy returns CallHierarchyItem[] verbatim and the calls methods forward the item", async () => {
  const fp = makeFakeProcess();
  const client = new LspClient(fp.proc, "/r");
  const pos = { line: 9, character: 4 };
  const item = {
    name: "Greeter", kind: 12,
    uri: "file:///r/a.ts",
    range: { start: { line: 9, character: 0 }, end: { line: 11, character: 1 } },
    selectionRange: { start: { line: 9, character: 4 }, end: { line: 9, character: 11 } },
  };

  const prep = client.prepareCallHierarchy("/r/a.ts", pos);
  await completeHandshake(fp);
  const prepReq = sentMessages(fp.stdinWrites).find(m => m.method === "textDocument/prepareCallHierarchy");
  expect(prepReq.params).toEqual({ textDocument: { uri: "file:///r/a.ts" }, position: pos });
  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: prepReq.id, result: [item] }));
  expect(await prep).toEqual([item]);

  const inP = client.incomingCalls(item);
  await flush();
  const inReq = sentMessages(fp.stdinWrites).find(m => m.method === "callHierarchy/incomingCalls");
  expect(inReq.params).toEqual({ item });
  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: inReq.id, result: [] }));
  expect(await inP).toEqual([]);

  const outP = client.outgoingCalls(item);
  await flush();
  const outReq = sentMessages(fp.stdinWrites).find(m => m.method === "callHierarchy/outgoingCalls");
  expect(outReq.params).toEqual({ item });
  fp.pushStdout(encodeRpcMessage({ jsonrpc: "2.0", id: outReq.id, result: null }));
  expect(await outP).toEqual([]);
});
