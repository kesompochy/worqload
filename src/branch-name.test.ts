import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeBranchName,
  resolveBranchNameClaudeBin,
  defaultBranchNameGenerator,
  makeBranchNameGenerator,
} from "./branch-name";
import type { TmuxDriverDeps } from "./session-driver-tmux";

describe("sanitizeBranchName", () => {
  test("accepts a simple kebab-case name", () => {
    expect(sanitizeBranchName("fix-login-bug")).toBe("fix-login-bug");
  });

  test("accepts a slashed name like feature/foo", () => {
    expect(sanitizeBranchName("feature/foo")).toBe("feature/foo");
  });

  test("strips surrounding whitespace and trailing newline", () => {
    expect(sanitizeBranchName("  fix-bug \n")).toBe("fix-bug");
  });

  test("takes only the first whitespace-separated token", () => {
    expect(sanitizeBranchName("fix-bug extra garbage")).toBe("fix-bug");
  });

  test("rejects empty string", () => {
    expect(sanitizeBranchName("")).toBeNull();
    expect(sanitizeBranchName("   ")).toBeNull();
  });

  test("rejects names with whitespace inside", () => {
    // already handled by token split, but a literal embedded space after sanitize is impossible
    expect(sanitizeBranchName("hello world")).toBe("hello"); // first token kept
  });

  test("rejects names with git-illegal characters", () => {
    for (const bad of ["foo:bar", "foo?bar", "foo*bar", "foo[bar", "foo\\bar", "foo~bar", "foo^bar"]) {
      expect(sanitizeBranchName(bad)).toBeNull();
    }
  });

  test("rejects names starting with - or /", () => {
    expect(sanitizeBranchName("-foo")).toBeNull();
    expect(sanitizeBranchName("/foo")).toBeNull();
  });

  test("rejects names containing ..", () => {
    expect(sanitizeBranchName("foo..bar")).toBeNull();
  });

  test("rejects names ending with .lock", () => {
    expect(sanitizeBranchName("foo.lock")).toBeNull();
  });

  test("rejects names ending with /", () => {
    expect(sanitizeBranchName("foo/")).toBeNull();
  });

  test("rejects names longer than the cap", () => {
    expect(sanitizeBranchName("a".repeat(61))).toBeNull();
    expect(sanitizeBranchName("a".repeat(60))).toBe("a".repeat(60));
  });

  test("rejects @{ sequence", () => {
    expect(sanitizeBranchName("foo@{bar")).toBeNull();
  });
});

describe("resolveBranchNameClaudeBin", () => {
  test("defaults to claude when WORQLOAD_SPAWN_COMMAND is unset", () => {
    expect(resolveBranchNameClaudeBin({})).toBe("claude");
  });

  test("defaults to claude when WORQLOAD_SPAWN_COMMAND is blank", () => {
    expect(resolveBranchNameClaudeBin({ WORQLOAD_SPAWN_COMMAND: "   " })).toBe("claude");
  });

  test("uses the executable (first token) of WORQLOAD_SPAWN_COMMAND", () => {
    expect(resolveBranchNameClaudeBin({ WORQLOAD_SPAWN_COMMAND: "  my-claude --flag x  " })).toBe("my-claude");
  });
});

describe("defaultBranchNameGenerator", () => {
  function writeFakeClaude(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "wq-branchname-"));
    const path = join(dir, "fake-claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  async function withPipeEnv<T>(spawnCommand: string, run: () => Promise<T>): Promise<T> {
    const prevSpawn = process.env.WORQLOAD_SPAWN_COMMAND;
    const prevDriver = process.env.WORQLOAD_DRIVER;
    process.env.WORQLOAD_SPAWN_COMMAND = spawnCommand;
    delete process.env.WORQLOAD_DRIVER;
    try {
      return await run();
    } finally {
      if (prevSpawn === undefined) delete process.env.WORQLOAD_SPAWN_COMMAND;
      else process.env.WORQLOAD_SPAWN_COMMAND = prevSpawn;
      if (prevDriver === undefined) delete process.env.WORQLOAD_DRIVER;
      else process.env.WORQLOAD_DRIVER = prevDriver;
    }
  }

  test("invokes the WORQLOAD_SPAWN_COMMAND binary and returns its sanitized output", async () => {
    const fake = writeFakeClaude("echo 'auto-generated-name extra words'");
    const name = await withPipeEnv(fake, () => defaultBranchNameGenerator("do a thing"));
    expect(name).toBe("auto-generated-name");
  });

  test("returns null when the spawned binary exits non-zero", async () => {
    const fake = writeFakeClaude("exit 1");
    const name = await withPipeEnv(fake, () => defaultBranchNameGenerator("do a thing"));
    expect(name).toBeNull();
  });
});

describe("makeBranchNameGenerator with WORQLOAD_DRIVER=tmux", () => {
  async function withDriverTmux<T>(run: () => Promise<T>): Promise<T> {
    const prev = process.env.WORQLOAD_DRIVER;
    process.env.WORQLOAD_DRIVER = "tmux";
    try {
      return await run();
    } finally {
      if (prev === undefined) delete process.env.WORQLOAD_DRIVER;
      else process.env.WORQLOAD_DRIVER = prev;
    }
  }

  test("routes branch naming through the tmux one-shot and sanitizes its assistant text", async () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), "wq-bn-tmux-tx-"));
    const bootstrapDir = mkdtempSync(join(tmpdir(), "wq-bn-tmux-bs-"));
    let newSessionSeen = false;
    const tmuxDeps: TmuxDriverDeps = {
      tmuxRun: async (args) => {
        if (args[0] === "new-session") {
          newSessionSeen = true;
          // The generator mints its own UUID; recover it from the spawned
          // command and write the transcript claude would have produced.
          const shellCmd = args.at(-1) ?? "";
          const id = shellCmd.match(/'--session-id' '([^']+)'/)?.[1];
          if (id) {
            await writeFile(
              join(transcriptDir, `${id}.jsonl`),
              `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tmux-named branch" }] } })}\n`,
            );
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      resolveTranscriptDir: () => transcriptDir,
      pollIntervalMs: 10,
      transcriptWaitTimeoutMs: 2000,
      bootstrapFileDir: bootstrapDir,
    };

    const name = await withDriverTmux(() => makeBranchNameGenerator(tmuxDeps)("build a thing"));

    expect(newSessionSeen).toBe(true);
    expect(name).toBe("tmux-named");
  });

  test("falls back to null (caller uses shortId) when the tmux one-shot produces no answer", async () => {
    const transcriptDir = mkdtempSync(join(tmpdir(), "wq-bn-tmux-tx-"));
    const tmuxDeps: TmuxDriverDeps = {
      tmuxRun: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      resolveTranscriptDir: () => transcriptDir,
      pollIntervalMs: 10,
      transcriptWaitTimeoutMs: 120,
      bootstrapFileDir: mkdtempSync(join(tmpdir(), "wq-bn-tmux-bs-")),
    };

    const name = await withDriverTmux(() => makeBranchNameGenerator(tmuxDeps)("build a thing"));

    expect(name).toBeNull();
  });
});
