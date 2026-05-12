import { test, expect } from "bun:test";
import { buildWebFrontend, webFrontendBuilt } from "./web-build";

// The browser can't be exercised here, so this is the safety net for the
// frontend: running the real Vite production build resolves the whole module
// graph (vanilla modules + Svelte components), so missing exports / typos /
// broken paths / Svelte compile errors all surface as a build failure.
test("the Vite production build of web/ succeeds", async () => {
  await buildWebFrontend();
  expect(webFrontendBuilt()).toBe(true);
});
