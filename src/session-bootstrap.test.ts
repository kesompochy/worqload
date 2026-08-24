import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProtocolPrefix } from "./session-bootstrap";
import { makeTmpDir } from "./test-helpers";

const installedScriptPath = join(import.meta.dir, "..", "bin", "wq-issue-comment");

const NO_CONFIG = join(makeTmpDir("bootstrap-no-config"), "nonexistent.yaml");

describe("buildProtocolPrefix", () => {
  test("substitutes the wq-issue-comment path with the given path", async () => {
    const prefix = await buildProtocolPrefix("main", "/opt/worqload/bin/wq-issue-comment", NO_CONFIG);
    expect(prefix).toContain("/opt/worqload/bin/wq-issue-comment");
    expect(prefix).not.toContain("{{wqIssueComment}}");
  });

  test("defaults the wq-issue-comment path to the script in the worqload install", async () => {
    expect(existsSync(installedScriptPath)).toBe(true);
    expect(await buildProtocolPrefix("main", undefined, NO_CONFIG)).toContain(installedScriptPath);
  });

  test("leaves no unfilled placeholders when config is absent", async () => {
    expect(await buildProtocolPrefix("main", undefined, NO_CONFIG)).not.toContain("{{");
  });

  test("injects protocolPrefix from config into the template", async () => {
    const dir = makeTmpDir("bootstrap-with-config");
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "protocolPrefix: \"- Custom git rule one\\n- Custom git rule two\"\n");
    const prefix = await buildProtocolPrefix("main", installedScriptPath, configPath);
    expect(prefix).toContain("Custom git rule one");
    expect(prefix).not.toContain("{{custom-protocol-prefix}}");
  });

  test("substitutes {{baseBranch}} inside protocolPrefix config value", async () => {
    const dir = makeTmpDir("bootstrap-basebranch-in-config");
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "protocolPrefix: \"check merge into '{{baseBranch}}'\"\n");
    const prefix = await buildProtocolPrefix("release-2026", installedScriptPath, configPath);
    expect(prefix).toContain("release-2026");
    expect(prefix).not.toContain("{{baseBranch}}");
  });

  test("custom-protocol-prefix is empty when config has no protocolPrefix key", async () => {
    const dir = makeTmpDir("bootstrap-no-key");
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "textlint: []\n");
    const prefix = await buildProtocolPrefix("main", installedScriptPath, configPath);
    expect(prefix).not.toContain("{{custom-protocol-prefix}}");
    expect(prefix).toContain("Files & git:");
  });
});
