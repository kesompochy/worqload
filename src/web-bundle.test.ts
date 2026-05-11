import { test, expect } from "bun:test";
import { join } from "node:path";

// The browser can't be exercised here, so this is the safety net for the
// frontend module split: bundling web/app.js resolves the whole import graph
// and parses every module, catching missing exports / typos / broken paths.
test("web/app.js bundles cleanly", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "web", "app.js")],
    target: "browser",
    format: "esm",
  });
  expect(result.logs.filter((l) => l.level === "error")).toEqual([]);
  expect(result.success).toBe(true);
});
