import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerLanguageServerExtension,
  clearLanguageServerExtensions,
  findDefinition,
  findReferences,
  shutdownAllLanguageServers,
  type LanguageServerExtension,
} from "./language-servers";
import { encodeRpcMessage, createRpcMessageParser, type LspServerProcess } from "./lsp-client";

// A fake stdio language server that answers requests from a canned handler map.
function autoFakeServer(
  handlers: Record<string, (params: unknown) => unknown>,
  counters?: { initialize?: number },
): LspServerProcess {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const tick = () => { const w = wake; wake = null; w?.(); };
  const stdout = (async function* () {
    for (;;) {
      if (queue.length > 0) { yield queue.shift() as Uint8Array; continue; }
      if (ended) return;
      await new Promise<void>(r => { wake = r; });
    }
  })();
  let resolveExited!: () => void;
  const exited = new Promise<void>(r => { resolveExited = r; });
  const parser = createRpcMessageParser();
  const allHandlers: Record<string, (params: unknown) => unknown> = { shutdown: () => null, ...handlers };
  return {
    writeStdin(bytes) {
      for (const message of parser.feed(bytes)) {
        const m = message as { id?: number; method?: string; params?: unknown };
        if (m.method === "initialize" && counters) counters.initialize = (counters.initialize ?? 0) + 1;
        if (typeof m.id === "number" && m.method && allHandlers[m.method]) {
          queue.push(encodeRpcMessage({ jsonrpc: "2.0", id: m.id, result: allHandlers[m.method](m.params) }));
          tick();
        }
      }
    },
    stdout,
    exited,
    kill() { ended = true; tick(); resolveExited(); },
  };
}

let worktreeDir: string | null = null;

afterEach(async () => {
  await shutdownAllLanguageServers();
  clearLanguageServerExtensions();
  if (worktreeDir) { rmSync(worktreeDir, { recursive: true, force: true }); worktreeDir = null; }
});

function makeWorktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "worqload-ln-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  worktreeDir = dir;
  return dir;
}

test("findDefinition returns null when no extension is registered for the language", async () => {
  clearLanguageServerExtensions();
  const dir = makeWorktree({ "a.ts": "x\n" });
  expect(await findDefinition(dir, "typescript", "a.ts", 0, 0)).toBeNull();
  expect(await findDefinition(dir, null, "a.ts", 0, 0)).toBeNull();
});

test("findDefinition resolves via the language server and maps URIs to worktree-relative path:line with the source line", async () => {
  clearLanguageServerExtensions();
  const dir = makeWorktree({
    "a.ts": "import { thing } from './lib/x';\nthing();\n",
    "lib/x.ts": "// header\nexport function thing() {}\n",
  });
  registerLanguageServerExtension({
    id: "fake-ts",
    languageIds: ["typescript", "javascript"],
    start: () => autoFakeServer({
      initialize: () => ({ capabilities: {} }),
      "textDocument/definition": () => ({
        uri: `file://${dir}/lib/x.ts`,
        range: { start: { line: 1, character: 16 }, end: { line: 1, character: 21 } },
      }),
    }),
  });
  expect(await findDefinition(dir, "typescript", "a.ts", 1, 0)).toEqual([
    { path: "lib/x.ts", line: 2, character: 16, text: "export function thing() {}" },
  ]);
});

test("findReferences flattens the location list and drops anything outside the worktree", async () => {
  clearLanguageServerExtensions();
  const dir = makeWorktree({
    "a.ts": "export const v = 1;\nconsole.log(v);\n",
  });
  registerLanguageServerExtension({
    id: "fake-ts",
    languageIds: ["typescript"],
    start: () => autoFakeServer({
      initialize: () => ({ capabilities: {} }),
      "textDocument/references": () => [
        { uri: `file://${dir}/a.ts`, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } } },
        { uri: `file://${dir}/a.ts`, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 13 } } },
        { uri: "file:///somewhere/else/node_modules/lib/index.d.ts", range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } },
      ],
    }),
  });
  expect(await findReferences(dir, "typescript", "a.ts", 0, 13)).toEqual([
    { path: "a.ts", line: 1, character: 13, text: "export const v = 1;" },
    { path: "a.ts", line: 2, character: 12, text: "console.log(v);" },
  ]);
});

test("the language server is started once per worktree and reused across queries", async () => {
  clearLanguageServerExtensions();
  const dir = makeWorktree({ "a.ts": "const a = 1;\n" });
  const counters = { initialize: 0 };
  const extension: LanguageServerExtension = {
    id: "fake-ts",
    languageIds: ["typescript"],
    start: () => autoFakeServer({
      initialize: () => ({ capabilities: {} }),
      "textDocument/definition": () => null,
      "textDocument/references": () => null,
    }, counters),
  };
  registerLanguageServerExtension(extension);
  await findDefinition(dir, "typescript", "a.ts", 0, 6);
  await findReferences(dir, "typescript", "a.ts", 0, 6);
  await findDefinition(dir, "typescript", "a.ts", 0, 6);
  expect(counters.initialize).toBe(1);
});

test("registering an extension with an existing id replaces it", async () => {
  clearLanguageServerExtensions();
  const dir = makeWorktree({ "a.ts": "x\n" });
  registerLanguageServerExtension({
    id: "ts", languageIds: ["typescript"],
    start: () => autoFakeServer({ initialize: () => ({ capabilities: {} }), "textDocument/definition": () => ({ uri: `file://${dir}/a.ts`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }) }),
  });
  registerLanguageServerExtension({
    id: "ts", languageIds: ["typescript"],
    start: () => autoFakeServer({ initialize: () => ({ capabilities: {} }), "textDocument/definition": () => null }),
  });
  expect(await findDefinition(dir, "typescript", "a.ts", 0, 0)).toEqual([]);
});
