import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { feedback } from "./feedback";
import { saveFeedback, loadFeedback, type Feedback } from "../feedback";
import { SHORT_ID_LENGTH } from "../task";

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
  tmpDir = mkdtempSync(join(tmpdir(), "worqload-feedback-cmd-"));
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

function makeFeedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    id: crypto.randomUUID(),
    from: "tester",
    message: "test feedback",
    status: "new",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("feedback command", () => {
  beforeEach(setup);
  afterEach(() => process.chdir(originalCwd));

  describe("list", () => {
    test("prints message when no feedback exists", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["No feedback."]);
    });

    test("lists items with status, message, sender, and short id", async () => {
      const fb = makeFeedback({ message: "fix the bug", from: "alice" });
      await saveFeedback([fb]);
      const out = captureOutput();
      try {
        await feedback(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toHaveLength(1);
      expect(out.logs[0]).toContain("fix the bug");
      expect(out.logs[0]).toContain("alice");
      expect(out.logs[0]).toContain("new");
      expect(out.logs[0]).toContain(fb.id.slice(0, SHORT_ID_LENGTH));
    });

    test("lists multiple items", async () => {
      await saveFeedback([
        makeFeedback({ message: "first", from: "a" }),
        makeFeedback({ message: "second", from: "b" }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toHaveLength(2);
    });
  });

  describe("summary", () => {
    test("shows zero counts when empty", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["summary"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toBe("--- Feedback Summary ---");
      expect(out.logs[1]).toContain("new: 0");
      expect(out.logs[1]).toContain("acknowledged: 0");
      expect(out.logs[1]).toContain("resolved: 0");
    });

    test("shows counts by status", async () => {
      await saveFeedback([
        makeFeedback({ status: "new" }),
        makeFeedback({ status: "new" }),
        makeFeedback({ status: "acknowledged" }),
        makeFeedback({ status: "resolved" }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["summary"]);
      } finally {
        out.restore();
      }
      expect(out.logs[1]).toContain("new: 2");
      expect(out.logs[1]).toContain("acknowledged: 1");
      expect(out.logs[1]).toContain("resolved: 1");
    });

    test("shows recent unresolved items", async () => {
      await saveFeedback([
        makeFeedback({ message: "pending issue", status: "new", from: "bob" }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["summary"]);
      } finally {
        out.restore();
      }
      const allOutput = out.logs.join("\n");
      expect(allOutput).toContain("Recent unresolved:");
      expect(allOutput).toContain("pending issue");
      expect(allOutput).toContain("bob");
    });

    test("shows themes when sender has 3+ unresolved items", async () => {
      await saveFeedback([
        makeFeedback({ from: "charlie", status: "new" }),
        makeFeedback({ from: "charlie", status: "new" }),
        makeFeedback({ from: "charlie", status: "acknowledged" }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["summary"]);
      } finally {
        out.restore();
      }
      const allOutput = out.logs.join("\n");
      expect(allOutput).toContain("Themes:");
      expect(allOutput).toContain("charlie");
    });
  });

  describe("ack", () => {
    test("acknowledges feedback and prints confirmation", async () => {
      const fb = makeFeedback();
      await saveFeedback([fb]);
      const out = captureOutput();
      try {
        await feedback(queue, ["ack", fb.id]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["Acknowledged."]);
      const items = await loadFeedback();
      expect(items[0].status).toBe("acknowledged");
    });

    test("acknowledges by prefix id", async () => {
      const fb = makeFeedback();
      await saveFeedback([fb]);
      const out = captureOutput();
      try {
        await feedback(queue, ["ack", fb.id.slice(0, SHORT_ID_LENGTH)]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["Acknowledged."]);
      const items = await loadFeedback();
      expect(items[0].status).toBe("acknowledged");
    });
  });

  describe("resolve", () => {
    test("resolves feedback and prints confirmation", async () => {
      const fb = makeFeedback();
      await saveFeedback([fb]);
      const out = captureOutput();
      try {
        await feedback(queue, ["resolve", fb.id]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["Resolved."]);
      const items = await loadFeedback();
      expect(items[0].status).toBe("resolved");
    });
  });

  describe("add (default)", () => {
    test("adds feedback with anonymous sender by default", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["improve", "the", "tests"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("Feedback added");
      expect(out.logs[0]).toContain("improve the tests");
      expect(out.logs[0]).toContain("anonymous");
      const items = await loadFeedback();
      expect(items).toHaveLength(1);
      expect(items[0].message).toBe("improve the tests");
      expect(items[0].from).toBe("anonymous");
    });

    test("uses --from flag for sender", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["good", "work", "--from", "bob"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("bob");
      const items = await loadFeedback();
      expect(items[0].from).toBe("bob");
    });

    test("includes short id in output", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["hello"]);
      } finally {
        out.restore();
      }
      const items = await loadFeedback();
      expect(out.logs[0]).toContain(items[0].id.slice(0, SHORT_ID_LENGTH));
    });

    test("exits with error when message is empty", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await feedback(queue, []);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Usage:");
    });

    test("exits with error when only --from flag is provided", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await feedback(queue, ["--from", "bob"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Usage:");
    });
  });

  describe("distill", () => {
    test("reports no resolved feedback when none exists", async () => {
      const out = captureOutput();
      try {
        await feedback(queue, ["distill"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["No resolved feedback to distill."]);
    });

    test("distills resolved feedback into rules and updates template", async () => {
      mkdirSync(join(tmpDir, ".claude/skills/worqload"), { recursive: true });
      await Bun.write(
        join(tmpDir, ".claude/skills/worqload/SKILL.md"),
        "# Agent\n\n## Rules\n- Existing rule\n",
      );
      await saveFeedback([
        makeFeedback({
          message: "Always write tests first",
          status: "resolved",
        }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["distill"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("Distilled 1 feedback item(s)");
      expect(out.logs[1]).toContain("Always write tests first");

      const template = await Bun.file(
        join(tmpDir, ".claude/skills/worqload/SKILL.md"),
      ).text();
      expect(template).toContain("- Always write tests first");
    });

    test("skips non-resolved feedback", async () => {
      await saveFeedback([
        makeFeedback({ message: "Always test", status: "new" }),
        makeFeedback({ message: "Never skip", status: "acknowledged" }),
      ]);
      const out = captureOutput();
      try {
        await feedback(queue, ["distill"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["No resolved feedback to distill."]);
    });
  });
});
