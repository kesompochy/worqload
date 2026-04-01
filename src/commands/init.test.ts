import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TaskQueue } from "../queue";
import { init } from "./init";

const initSource = readFileSync(
  new URL("./init.ts", import.meta.url),
  "utf-8",
);

const templateMatch = initSource.match(
  /const DEFAULT_AGENT_TEMPLATE = `([\s\S]*?)`;/,
);
if (!templateMatch) throw new Error("DEFAULT_AGENT_TEMPLATE not found");

const template = templateMatch[1]
  .replace(/\\\\\\\`\\\\\\\`\\\\\\\`/g, "```")
  .replace(/\\\\\`/g, "`");

describe("DEFAULT_AGENT_TEMPLATE covers worqload commands", () => {
  test("mentions heartbeat command", () => {
    expect(template).toContain("heartbeat");
  });

  test("mentions sleep and wake commands", () => {
    expect(template).toContain("worqload sleep");
    expect(template).toContain("worqload wake");
  });

  test("mentions all OODA phase commands", () => {
    expect(template).toContain("worqload observe");
    expect(template).toContain("worqload orient");
    expect(template).toContain("worqload decide");
    expect(template).toContain("worqload act");
    expect(template).toContain("worqload done");
  });

  test("mentions fail and retry commands", () => {
    expect(template).toContain("worqload fail");
    expect(template).toContain("worqload retry");
  });

  test("mentions task inspection commands", () => {
    expect(template).toContain("worqload show");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers OODA workflow", () => {
  test("documents status transitions", () => {
    expect(template).not.toContain("pending");
    expect(template).toContain("observing");
    expect(template).toContain("orienting");
    expect(template).toContain("deciding");
    expect(template).toContain("acting");
    expect(template).toContain("waiting_human");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers human escalation", () => {
  test("explains --human flag", () => {
    expect(template).toContain("--human");
  });

  test("explains what happens after human responds", () => {
    expect(template).toMatch(/waiting_human.*orient/s);
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers missions", () => {
  test("explains WORQLOAD_MISSION_PRINCIPLES env var", () => {
    expect(template).toContain("WORQLOAD_MISSION_PRINCIPLES");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers feedback", () => {
  test("mentions feedback list command", () => {
    expect(template).toContain("worqload feedback list");
  });

  test("mentions feedback ack and resolve commands", () => {
    expect(template).toContain("feedback ack");
    expect(template).toContain("feedback resolve");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers spawned agent env vars", () => {
  test("documents WORQLOAD_TASK_ID env var", () => {
    expect(template).toContain("WORQLOAD_TASK_ID");
  });

  test("documents WORQLOAD_TASK_TITLE env var", () => {
    expect(template).toContain("WORQLOAD_TASK_TITLE");
  });

  test("documents WORQLOAD_TASK_CONTEXT env var", () => {
    expect(template).toContain("WORQLOAD_TASK_CONTEXT");
  });

  test("documents WORQLOAD_CLI env var", () => {
    expect(template).toContain("WORQLOAD_CLI");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers spawned agent escalation", () => {
  test("instructs spawned agents to escalate via exit code 3", () => {
    expect(template).toContain("exit 3");
    expect(template).toContain("waiting_human");
  });

  test("prohibits spawned agents from calling orient --human directly", () => {
    expect(template).toContain("CANNOT");
    expect(template).toContain("orient --human");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers session resume", () => {
  test("mentions worqload resume command", () => {
    expect(template).toContain("worqload resume");
  });

  test("documents resume as first command for session start", () => {
    const resumeIndex = template.indexOf("worqload resume");
    const sleepIndex = template.indexOf("worqload sleep");
    expect(resumeIndex).toBeLessThan(sleepIndex);
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers reports", () => {
  test("mentions report add command with task-id", () => {
    expect(template).toContain("worqload report add");
  });

  test("mentions report status lifecycle", () => {
    expect(template).toContain("report status");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers principle-driven Orient", () => {
  test("explains that Orient compares observations against Principles", () => {
    expect(template).toMatch(/[Oo]rient.*[Pp]rinciple/s);
  });

  test("explains escalation criteria: Principles sufficient vs insufficient", () => {
    expect(template).toMatch(/[Pp]rinciple.*sufficient/is);
  });

  test("explains that every decision must trace back to a Principle", () => {
    expect(template).toMatch(/decision.*trace.*[Pp]rinciple/is);
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers main session role", () => {
  test("explains main session manages queue, not implementation", () => {
    expect(template).toMatch(/spawn|delegate/i);
    expect(template).toMatch(/queue/i);
  });

  test("mentions iterate command", () => {
    expect(template).toContain("worqload iterate");
  });

  test("mentions spawn-cleanup command", () => {
    expect(template).toContain("worqload spawn-cleanup");
  });
});

describe("DEFAULT_AGENT_TEMPLATE covers feedback-to-task flow", () => {
  test("explains feedback is human Orient output", () => {
    expect(template).toMatch(/feedback.*human/is);
  });

  test("explains feedback should be oriented against Principles to derive tasks", () => {
    expect(template).toMatch(/feedback.*[Pp]rinciple/s);
  });
});

describe("init adds .worktrees to .gitignore", () => {
  let tempDir: string;
  let origCwd: string;
  const origLog = console.log;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "worqload-init-gitignore-"));
    origCwd = process.cwd();
    process.chdir(tempDir);
    console.log = () => {};
  });

  afterEach(async () => {
    process.chdir(origCwd);
    console.log = origLog;
    await rm(tempDir, { recursive: true, force: true });
  });

  function tmpQueuePath(): string {
    return join(tempDir, `queue-${crypto.randomUUID()}.json`);
  }

  test("creates .gitignore with .worktrees when no .gitignore exists", async () => {
    const queue = new TaskQueue(tmpQueuePath());
    await init(queue, [tempDir]);

    const content = await readFile(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain(".worktrees");
  });

  test("appends .worktrees to existing .gitignore that lacks it", async () => {
    await writeFile(join(tempDir, ".gitignore"), "node_modules\n");
    const queue = new TaskQueue(tmpQueuePath());
    await init(queue, [tempDir]);

    const content = await readFile(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".worktrees");
  });

  test("does not duplicate .worktrees if already present", async () => {
    await writeFile(join(tempDir, ".gitignore"), ".worktrees\nnode_modules\n");
    const queue = new TaskQueue(tmpQueuePath());
    await init(queue, [tempDir]);

    const content = await readFile(join(tempDir, ".gitignore"), "utf-8");
    const matches = content.match(/\.worktrees/g);
    expect(matches).toHaveLength(1);
  });

  test("handles .worktrees/ with trailing slash as already present", async () => {
    await writeFile(join(tempDir, ".gitignore"), ".worktrees/\n");
    const queue = new TaskQueue(tmpQueuePath());
    await init(queue, [tempDir]);

    const content = await readFile(join(tempDir, ".gitignore"), "utf-8");
    const matches = content.match(/\.worktrees/g);
    expect(matches).toHaveLength(1);
  });
});
