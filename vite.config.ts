import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The browser frontend lives in web/; the rest of the repo is the Bun server.
// web/index.html is the Vite entry and the build lands in web/dist/, which
// web-server.ts serves (index.html at /, hashed bundles at /assets/*).
export default defineConfig({
  root: "web",
  plugins: [svelte()],
});
