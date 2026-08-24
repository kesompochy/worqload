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

test("preferredWatchPort returns null when the user gave an explicit port", () => {
  withTmpDir((dir) => {
    const sentinel = join(dir, "watch.port");
    writeFileSync(sentinel, "4000");
    expect(preferredWatchPort(sentinel, 3500)).toBeNull();
    expect(preferredWatchPort(sentinel, 0)).toBeNull();
  });
});

test("preferredWatchPort returns null when the sentinel file is missing or garbage", () => {
  withTmpDir((dir) => {
    expect(preferredWatchPort(join(dir, "absent.port"), null)).toBeNull();
    const garbage = join(dir, "garbage.port");
    writeFileSync(garbage, "not-a-port");
    expect(preferredWatchPort(garbage, null)).toBeNull();
    const outOfRange = join(dir, "range.port");
    writeFileSync(outOfRange, "99999");
    expect(preferredWatchPort(outOfRange, null)).toBeNull();
  });
});

