import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planWatchRespawn, preferredWatchPort, recordWatchPort, WATCH_RESPAWN_MARKER } from "./serve";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "serve-port-sentinel-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("planWatchRespawn returns null when --watch is absent", () => {
  const plan = planWatchRespawn(["3500"], {
    execPath: "/usr/bin/bun",
    scriptPath: "/repo/src/cli.ts",
    env: {},
  });
  expect(plan).toBeNull();
});

test("planWatchRespawn returns null when the marker env var is already set", () => {
  const plan = planWatchRespawn(["--watch"], {
    execPath: "/usr/bin/bun",
    scriptPath: "/repo/src/cli.ts",
    env: { [WATCH_RESPAWN_MARKER]: "1" },
  });
  expect(plan).toBeNull();
});

test("planWatchRespawn builds a bun --watch command, strips --watch, and preserves other args", () => {
  const plan = planWatchRespawn(["--watch", "3500", "--no-open"], {
    execPath: "/usr/bin/bun",
    scriptPath: "/repo/src/cli.ts",
    env: { HOME: "/h" },
  });
  if (plan === null) throw new Error("expected a respawn plan");
  expect(plan.command).toEqual(["/usr/bin/bun", "--watch", "/repo/src/cli.ts", "serve", "3500", "--no-open"]);
  expect(plan.env[WATCH_RESPAWN_MARKER]).toBe("1");
  expect(plan.env.HOME).toBe("/h");
});

test("planWatchRespawn places --watch only once even if the user supplied it twice", () => {
  const plan = planWatchRespawn(["--watch", "--watch", "--no-open"], {
    execPath: "/usr/bin/bun",
    scriptPath: "/repo/src/cli.ts",
    env: {},
  });
  if (plan === null) throw new Error("expected a respawn plan");
  const watchCount = plan.command.filter((a) => a === "--watch").length;
  expect(watchCount).toBe(1);
  expect(plan.command).toContain("--no-open");
});

test("preferredWatchPort returns null when there is no sentinel path", () => {
  expect(preferredWatchPort(undefined, null)).toBeNull();
});

test("preferredWatchPort reads the port a previous boot recorded", () => {
  withTmpDir((dir) => {
    const sentinel = join(dir, "watch.port");
    recordWatchPort(sentinel, 3461);
    expect(preferredWatchPort(sentinel, null)).toBe(3461);
  });
});

test("recordWatchPort is a no-op without a sentinel path", () => {
  expect(() => recordWatchPort(undefined, 3456)).not.toThrow();
});
