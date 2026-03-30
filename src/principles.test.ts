import { test, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { loadPrinciples, savePrinciples } from "./principles";

function tmpPath(): string {
  return join(tmpdir(), `worqload-principles-test-${crypto.randomUUID()}.md`);
}

test("loadPrinciples returns empty string when file does not exist", async () => {
  expect(await loadPrinciples(tmpPath())).toBe("");
});

test("savePrinciples then loadPrinciples round-trips content", async () => {
  const path = tmpPath();
  await savePrinciples("- principle 1\n- principle 2", path);

  const content = await loadPrinciples(path);
  expect(content).toBe("- principle 1\n- principle 2");
});

test("savePrinciples overwrites previous content", async () => {
  const path = tmpPath();
  await savePrinciples("old", path);
  await savePrinciples("new", path);

  expect(await loadPrinciples(path)).toBe("new");
});
