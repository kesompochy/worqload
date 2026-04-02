import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { principle } from "./principle";
import { savePrinciples, loadPrinciples } from "../principles";

const originalCwd = process.cwd();
let tmpDir: string;
let queue: TaskQueue;

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "worqload-principle-cmd-"));
  mkdirSync(join(tmpDir, ".worqload"), { recursive: true });
  process.chdir(tmpDir);
  queue = new TaskQueue();
}

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never;
  return {
    logs,
    errors,
    restore() {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
}

describe("principle command", () => {
  beforeEach(setup);
  afterEach(() => process.chdir(originalCwd));

  describe("list", () => {
    test("prints message when no principles exist", async () => {
      const out = captureOutput();
      try {
        await principle(queue, []);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("No principles defined.");
      expect(out.logs[1]).toContain("Usage:");
    });

    test("prints message with explicit list arg", async () => {
      const out = captureOutput();
      try {
        await principle(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("No principles defined.");
    });

    test("lists principles with numbered indices", async () => {
      await savePrinciples("# Principles\n\n- First\n- Second\n- Third");
      const out = captureOutput();
      try {
        await principle(queue, []);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("# Principles\n");
      expect(out.logs[1]).toBe("1. First");
      expect(out.logs[2]).toBe("2. Second");
      expect(out.logs[3]).toBe("3. Third");
    });
  });

  describe("add", () => {
    test("adds a principle to empty file", async () => {
      const out = captureOutput();
      try {
        await principle(queue, ["Write", "tests", "first"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("Principle added: Write tests first");
      const content = await loadPrinciples();
      expect(content).toContain("- Write tests first");
    });

    test("appends to existing principles", async () => {
      await savePrinciples("# Principles\n\n- Existing rule");
      const out = captureOutput();
      try {
        await principle(queue, ["New", "rule"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("Principle added: New rule");
      const content = await loadPrinciples();
      expect(content).toContain("- Existing rule");
      expect(content).toContain("- New rule");
    });
  });

  describe("edit", () => {
    test("updates a principle by index", async () => {
      await savePrinciples("# Principles\n\n- Old text\n- Keep this");
      const out = captureOutput();
      try {
        await principle(queue, ["edit", "1", "New", "text"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("Principle updated (#1): New text");
      const content = await loadPrinciples();
      expect(content).toContain("- New text");
      expect(content).toContain("- Keep this");
      expect(content).not.toContain("- Old text");
    });

    test("exits with error for invalid index", async () => {
      await savePrinciples("# Principles\n\n- Only one");
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await principle(queue, ["edit", "5", "text"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid index");
    });

    test("exits with error when no new text provided", async () => {
      await savePrinciples("# Principles\n\n- Existing");
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await principle(queue, ["edit", "1"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Usage:");
    });

    test("exits with error for non-numeric index", async () => {
      await savePrinciples("# Principles\n\n- Existing");
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await principle(queue, ["edit", "abc", "text"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid index");
    });
  });

  describe("remove", () => {
    test("removes a principle by index", async () => {
      await savePrinciples("# Principles\n\n- First\n- Second\n- Third");
      const out = captureOutput();
      try {
        await principle(queue, ["remove", "2"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("Principle removed (#2).");
      const content = await loadPrinciples();
      expect(content).toContain("- First");
      expect(content).not.toContain("- Second");
      expect(content).toContain("- Third");
    });

    test("removes the last principle leaving empty content", async () => {
      await savePrinciples("# Principles\n\n- Only one");
      const out = captureOutput();
      try {
        await principle(queue, ["remove", "1"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("Principle removed (#1).");
      const content = await loadPrinciples();
      expect(content).toBe("");
    });

    test("exits with error for invalid index", async () => {
      await savePrinciples("# Principles\n\n- Only one");
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await principle(queue, ["remove", "0"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid index");
    });

    test("exits with error for index beyond range", async () => {
      await savePrinciples("# Principles\n\n- Only one");
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await principle(queue, ["remove", "3"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid index");
    });
  });
});
