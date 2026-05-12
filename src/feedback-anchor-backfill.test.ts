import { test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "fs";
import { backfillFeedbackAnchors } from "./feedback-anchor-backfill";
import { makeTmpDir, cleanupAll } from "./test-helpers";

afterEach(cleanupAll);

function feedbackDir(sessionsDir: string, sessionId: string, sub: "inbox" | "read"): string {
  const dir = join(sessionsDir, sessionId, "feedback", sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("backfill moves a leading Re: anchor line into a sidecar and strips it from the body", async () => {
  const sessionsDir = makeTmpDir("sessions");
  const inbox = feedbackDir(sessionsDir, "s1", "inbox");
  writeFileSync(join(inbox, "003-anchored.md"), "Re: src/foo.ts:40-45\n\nfix this please\nand also that\n");

  await backfillFeedbackAnchors(sessionsDir);

  expect(readFileSync(join(inbox, "003-anchored.md"), "utf8")).toBe("fix this please\nand also that\n");
  expect(JSON.parse(readFileSync(join(inbox, "003-anchored.meta.json"), "utf8"))).toEqual({
    anchor: { path: "src/foo.ts", lineStart: 40, lineEnd: 45 },
  });
});

test("backfill handles the read directory and single-line anchors", async () => {
  const sessionsDir = makeTmpDir("sessions");
  const read = feedbackDir(sessionsDir, "s1", "read");
  writeFileSync(join(read, "001-anchored.md"), "Re: ./.worqload-reports/002-x.md:7\n\nlook here\n");

  await backfillFeedbackAnchors(sessionsDir);

  expect(readFileSync(join(read, "001-anchored.md"), "utf8")).toBe("look here\n");
  expect(JSON.parse(readFileSync(join(read, "001-anchored.meta.json"), "utf8"))).toEqual({
    anchor: { path: "./.worqload-reports/002-x.md", lineStart: 7, lineEnd: 7 },
  });
});

test("backfill leaves non-anchored feedback and command/escalation replies untouched", async () => {
  const sessionsDir = makeTmpDir("sessions");
  const inbox = feedbackDir(sessionsDir, "s1", "inbox");
  writeFileSync(join(inbox, "001-feedback.md"), "plain feedback\n");
  writeFileSync(join(inbox, "002-command-approve.md"), "Re: command approval 002-command-approval.md\n\n...\n");
  writeFileSync(join(inbox, "003-answer-x.md"), "Re: escalation 003-x.md\n\n## Question\n\nq\n");

  await backfillFeedbackAnchors(sessionsDir);

  expect(readdirSync(inbox).sort()).toEqual(["001-feedback.md", "002-command-approve.md", "003-answer-x.md"]);
  expect(readFileSync(join(inbox, "001-feedback.md"), "utf8")).toBe("plain feedback\n");
});

test("backfill is idempotent: a file that already has a sidecar is left alone", async () => {
  const sessionsDir = makeTmpDir("sessions");
  const inbox = feedbackDir(sessionsDir, "s1", "inbox");
  writeFileSync(join(inbox, "001-anchored.md"), "already migrated body\n");
  writeFileSync(join(inbox, "001-anchored.meta.json"), JSON.stringify({ anchor: { path: "p", lineStart: 1, lineEnd: 1 } }));

  await backfillFeedbackAnchors(sessionsDir);

  expect(readFileSync(join(inbox, "001-anchored.md"), "utf8")).toBe("already migrated body\n");
  expect(JSON.parse(readFileSync(join(inbox, "001-anchored.meta.json"), "utf8"))).toEqual({ anchor: { path: "p", lineStart: 1, lineEnd: 1 } });
});

test("backfill tolerates a missing sessions directory", async () => {
  await backfillFeedbackAnchors(join(makeTmpDir("nope"), "does-not-exist"));
  // no throw
  expect(true).toBe(true);
});

test("backfill ignores an anchored file whose body no longer leads with a Re: line", async () => {
  const sessionsDir = makeTmpDir("sessions");
  const inbox = feedbackDir(sessionsDir, "s1", "inbox");
  writeFileSync(join(inbox, "001-anchored.md"), "no ref here\n");

  await backfillFeedbackAnchors(sessionsDir);

  expect(existsSync(join(inbox, "001-anchored.meta.json"))).toBe(false);
  expect(readFileSync(join(inbox, "001-anchored.md"), "utf8")).toBe("no ref here\n");
});
