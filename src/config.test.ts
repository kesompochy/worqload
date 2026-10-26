import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadProtocolPrefix, parseProtocolPrefix } from "./config";
import { makeTmpDir } from "./test-helpers";

test("loadProtocolPrefix returns null when the config file is absent", async () => {
  const dir = makeTmpDir("protocol-prefix-config");
  expect(await loadProtocolPrefix(join(dir, "config.yaml"))).toBeNull();
});

test("loadProtocolPrefix reads the protocol prefix from the config file on disk", async () => {
  const dir = makeTmpDir("protocol-prefix-config");
  const configPath = join(dir, ".config", "worqload", "config.yaml");
  mkdirSync(join(dir, ".config", "worqload"), { recursive: true });
  writeFileSync(configPath, 'protocolPrefix: "Custom git instructions here."\n');
  expect(await loadProtocolPrefix(configPath)).toBe("Custom git instructions here.");
});

test("parseProtocolPrefix returns null when key is absent", () => {
  expect(parseProtocolPrefix("kb: []\n")).toBeNull();
});

test("parseProtocolPrefix throws on empty string value", () => {
  expect(() => parseProtocolPrefix('protocolPrefix: ""\n')).toThrow();
});
