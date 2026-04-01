import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { report } from "./report";
import { saveReports, loadReports, type Report } from "../reports";
import { SHORT_ID_LENGTH } from "../task";

const originalCwd = process.cwd();
let tmpDir: string;
let queue: TaskQueue;
let originalNodeEnv: string | undefined;

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function setup() {
  originalNodeEnv = process.env.NODE_ENV;
  // guardDefaultPath skips .worqload/ paths when NODE_ENV=test.
  // Override to allow integration testing with temp directory isolation.
  delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), "worqload-report-cmd-"));
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

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: crypto.randomUUID(),
    title: "Test Report",
    content: "Test content body",
    status: "unread",
    createdBy: "tester",
    createdAt: new Date().toISOString(),
    category: "internal",
    ...overrides,
  };
}

describe("report command", () => {
  beforeEach(setup);
  afterEach(() => {
    process.chdir(originalCwd);
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe("list (default and explicit)", () => {
    test("prints message when no reports exist (no args)", async () => {
      const out = captureOutput();
      try {
        await report(queue, []);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["No reports."]);
    });

    test("prints message when no reports exist (list subcommand)", async () => {
      const out = captureOutput();
      try {
        await report(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["No reports."]);
    });

    test("lists reports with status, category, title, creator, and short id", async () => {
      const r = makeReport({ title: "Deploy Summary", createdBy: "agent-1" });
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toHaveLength(1);
      expect(out.logs[0]).toContain("Deploy Summary");
      expect(out.logs[0]).toContain("agent-1");
      expect(out.logs[0]).toContain("unread");
      expect(out.logs[0]).toContain("internal");
      expect(out.logs[0]).toContain(r.id.slice(0, SHORT_ID_LENGTH));
    });

    test("lists multiple reports", async () => {
      await saveReports([
        makeReport({ title: "First" }),
        makeReport({ title: "Second" }),
      ]);
      const out = captureOutput();
      try {
        await report(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toHaveLength(2);
    });

    test("shows category as internal when not set", async () => {
      const r = makeReport();
      delete (r as Record<string, unknown>).category;
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["list"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("internal");
    });
  });

  describe("show", () => {
    test("displays full report in markdown format", async () => {
      const r = makeReport({
        title: "Analysis",
        content: "Detailed findings here",
        createdBy: "agent-2",
      });
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["show", r.id]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("# Analysis");
      expect(out.logs[0]).toContain("Detailed findings here");
      expect(out.logs[0]).toContain("agent-2");
      expect(out.logs[0]).toContain(r.createdAt);
    });

    test("finds report by prefix id", async () => {
      const r = makeReport({ title: "Prefix Test" });
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["show", r.id.slice(0, SHORT_ID_LENGTH)]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("# Prefix Test");
    });

    test("exits with error when report not found", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["show", "nonexistent-id"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Report not found");
    });

    test("exits with error when id is missing", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["show"]);
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

  describe("add", () => {
    test("creates report with default creator and category", async () => {
      const out = captureOutput();
      try {
        await report(queue, ["add", "New Feature", "Implementation details"]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("Report added");
      expect(out.logs[0]).toContain("New Feature");
      expect(out.logs[0]).toContain("internal");
      const reports = await loadReports();
      expect(reports).toHaveLength(1);
      expect(reports[0].title).toBe("New Feature");
      expect(reports[0].content).toBe("Implementation details");
      expect(reports[0].createdBy).toBe("agent");
      expect(reports[0].category).toBe("internal");
    });

    test("uses --by flag for creator", async () => {
      const out = captureOutput();
      try {
        await report(queue, [
          "add",
          "Review",
          "Code review notes",
          "--by",
          "reviewer",
        ]);
      } finally {
        out.restore();
      }
      const reports = await loadReports();
      expect(reports[0].createdBy).toBe("reviewer");
    });

    test("uses --category flag", async () => {
      const out = captureOutput();
      try {
        await report(queue, [
          "add",
          "User Report",
          "Visible to humans",
          "--category",
          "human",
        ]);
      } finally {
        out.restore();
      }
      expect(out.logs[0]).toContain("human");
      const reports = await loadReports();
      expect(reports[0].category).toBe("human");
    });

    test("exits with error for invalid category", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, [
          "add",
          "Bad",
          "Content",
          "--category",
          "invalid",
        ]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid category");
    });

    test("exits with error when title or content is missing", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["add", "OnlyTitle"]);
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

  describe("status", () => {
    test("updates report status", async () => {
      const r = makeReport();
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["status", r.id, "read"]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["Report status updated: read"]);
      const reports = await loadReports();
      expect(reports[0].status).toBe("read");
    });

    test("supports all valid statuses", async () => {
      for (const status of ["unread", "reading", "read", "archived"]) {
        const r = makeReport();
        await saveReports([r]);
        const out = captureOutput();
        try {
          await report(queue, ["status", r.id, status]);
        } finally {
          out.restore();
        }
        expect(out.logs).toEqual([`Report status updated: ${status}`]);
      }
    });

    test("exits with error for invalid status", async () => {
      const r = makeReport();
      await saveReports([r]);
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["status", r.id, "invalid"]);
      } catch (e) {
        if (e instanceof ExitError) exitCode = e.code;
        else throw e;
      } finally {
        out.restore();
      }
      expect(exitCode).toBe(1);
      expect(out.errors[0]).toContain("Invalid status");
    });

    test("exits with error when id or status is missing", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["status"]);
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

  describe("remove", () => {
    test("removes report and prints confirmation", async () => {
      const r = makeReport();
      await saveReports([r]);
      const out = captureOutput();
      try {
        await report(queue, ["remove", r.id]);
      } finally {
        out.restore();
      }
      expect(out.logs).toEqual(["Report removed."]);
      const reports = await loadReports();
      expect(reports).toHaveLength(0);
    });

    test("exits with error when id is missing", async () => {
      const out = captureOutput();
      let exitCode: number | undefined;
      try {
        await report(queue, ["remove"]);
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
});
