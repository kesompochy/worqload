import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedback, loadFeedback, saveFeedback, acknowledgeFeedback, resolveFeedback, updateFeedbackMessage, summarizeFeedback, distillFeedback, extractActionableRules, extractObservationalContent, sendFeedbackToProject, loadDistilledRules, verifyDistilledRules, markRuleTaskCreated, type DistilledRule } from "./feedback";
import { registerProject, type Project } from "./projects";

function tmpPath(): string {
  return join(tmpdir(), `worqload-feedback-test-${crypto.randomUUID()}.json`);
}

test("loadFeedback returns empty array when file does not exist", async () => {
  expect(await loadFeedback(tmpPath())).toEqual([]);
});

test("addFeedback creates and persists a feedback item", async () => {
  const path = tmpPath();
  const item = await addFeedback("test message", "user1", path);

  expect(item.message).toBe("test message");
  expect(item.from).toBe("user1");
  expect(item.status).toBe("new");

  const loaded = await loadFeedback(path);
  expect(loaded).toHaveLength(1);
  expect(loaded[0].id).toBe(item.id);
});

test("acknowledgeFeedback changes status to acknowledged", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await acknowledgeFeedback(item.id, path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("acknowledged");
});

test("acknowledgeFeedback matches by id prefix", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await acknowledgeFeedback(item.id.slice(0, 8), path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("acknowledged");
});

test("acknowledgeFeedback throws for unknown id", async () => {
  const path = tmpPath();
  expect(acknowledgeFeedback("nonexistent", path)).rejects.toThrow("Feedback not found");
});

test("resolveFeedback changes status to resolved", async () => {
  const path = tmpPath();
  const item = await addFeedback("msg", "user1", path);

  await resolveFeedback(item.id, path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].status).toBe("resolved");
});

test("resolveFeedback throws for unknown id", async () => {
  const path = tmpPath();
  expect(resolveFeedback("nonexistent", path)).rejects.toThrow("Feedback not found");
});

test("updateFeedbackMessage updates message text", async () => {
  const path = tmpPath();
  const item = await addFeedback("original", "user1", path);

  await updateFeedbackMessage(item.id, "updated", path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].message).toBe("updated");
});

test("updateFeedbackMessage matches by id prefix", async () => {
  const path = tmpPath();
  const item = await addFeedback("original", "user1", path);

  await updateFeedbackMessage(item.id.slice(0, 8), "updated", path);
  const loaded = await loadFeedback(path);
  expect(loaded[0].message).toBe("updated");
});

test("updateFeedbackMessage throws for unknown id", async () => {
  const path = tmpPath();
  expect(updateFeedbackMessage("nonexistent", "msg", path)).rejects.toThrow("Feedback not found");
});

test("summarizeFeedback returns zero counts for empty feedback", async () => {
  const summary = summarizeFeedback([]);
  expect(summary.counts).toEqual({ new: 0, acknowledged: 0, resolved: 0 });
  expect(summary.recentUnresolved).toEqual([]);
  expect(summary.themes).toEqual([]);
});

test("summarizeFeedback counts by status", async () => {
  const path = tmpPath();
  await addFeedback("msg1", "user1", path);
  await addFeedback("msg2", "user2", path);
  const items = await loadFeedback(path);
  items[1].status = "acknowledged";
  const summary = summarizeFeedback(items);
  expect(summary.counts).toEqual({ new: 1, acknowledged: 1, resolved: 0 });
});

test("summarizeFeedback returns up to 5 recent unresolved items", async () => {
  const path = tmpPath();
  const items = [];
  for (let i = 0; i < 7; i++) {
    const f = await addFeedback(`msg${i}`, "user1", path);
    f.createdAt = new Date(Date.now() + i * 1000).toISOString();
    items.push(f);
  }
  await saveFeedback(items, path);
  items[0].status = "resolved";
  const summary = summarizeFeedback(items);
  expect(summary.recentUnresolved).toHaveLength(5);
  expect(summary.recentUnresolved[0].message).toBe("msg6");
});

test("summarizeFeedback detects repeated themes from same sender", async () => {
  const path = tmpPath();
  await addFeedback("UI is slow", "alice", path);
  await addFeedback("UI loading is slow", "alice", path);
  await addFeedback("UI performance is slow", "alice", path);
  const items = await loadFeedback(path);
  const summary = summarizeFeedback(items);
  // Repeated sender with 3+ items is a theme
  expect(summary.themes.length).toBeGreaterThanOrEqual(1);
  expect(summary.themes[0].description).toContain("alice");
});

test("summarizeFeedback themes include feedbackIds of unresolved items from that sender", async () => {
  const path = tmpPath();
  const f1 = await addFeedback("UI is slow", "alice", path);
  const f2 = await addFeedback("UI loading is slow", "alice", path);
  const f3 = await addFeedback("UI performance is slow", "alice", path);
  const items = await loadFeedback(path);
  const summary = summarizeFeedback(items);

  expect(summary.themes).toHaveLength(1);
  expect(summary.themes[0].feedbackIds).toEqual(expect.arrayContaining([f1.id, f2.id, f3.id]));
  expect(summary.themes[0].feedbackIds).toHaveLength(3);
});

test("summarizeFeedback returns unresolvedIds for all unresolved items", async () => {
  const path = tmpPath();
  const f1 = await addFeedback("msg1", "alice", path);
  const f2 = await addFeedback("msg2", "bob", path);
  const f3 = await addFeedback("msg3", "alice", path);
  const items = await loadFeedback(path);
  items[1].status = "resolved";
  const summary = summarizeFeedback(items);

  expect(summary.unresolvedIds).toEqual(expect.arrayContaining([f1.id, f3.id]));
  expect(summary.unresolvedIds).not.toContain(f2.id);
  expect(summary.unresolvedIds).toHaveLength(2);
});

describe("extractActionableRules", () => {
  test("extracts imperative English sentences starting with a verb", () => {
    expect(extractActionableRules("Always run lint before commit")).toEqual(["Always run lint before commit"]);
    expect(extractActionableRules("Use Japanese for all reports")).toEqual(["Use Japanese for all reports"]);
    expect(extractActionableRules("Run tests before pushing")).toEqual(["Run tests before pushing"]);
  });

  test("extracts sentences with 'should', 'must', 'never'", () => {
    expect(extractActionableRules("You should write tests first")).toEqual(["You should write tests first"]);
    expect(extractActionableRules("You must run CI before merge")).toEqual(["You must run CI before merge"]);
    expect(extractActionableRules("Never skip code review")).toEqual(["Never skip code review"]);
  });

  test("extracts sentences with 'do not' / 'don't'", () => {
    expect(extractActionableRules("Do not commit directly to main")).toEqual(["Do not commit directly to main"]);
    expect(extractActionableRules("Don't use console.log in production")).toEqual(["Don't use console.log in production"]);
  });

  test("extracts Japanese directive forms", () => {
    expect(extractActionableRules("テストを先に書くべき")).toEqual(["テストを先に書くべき"]);
    expect(extractActionableRules("コミット前にlintを実行しろ")).toEqual(["コミット前にlintを実行しろ"]);
    expect(extractActionableRules("日本語で書くこと")).toEqual(["日本語で書くこと"]);
    expect(extractActionableRules("テストを書いてくれ")).toEqual(["テストを書いてくれ"]);
    expect(extractActionableRules("レポートは日本語で書いてください")).toEqual(["レポートは日本語で書いてください"]);
    expect(extractActionableRules("mainに直接コミットするな")).toEqual(["mainに直接コミットするな"]);
    expect(extractActionableRules("console.logを使わないでください")).toEqual(["console.logを使わないでください"]);
    expect(extractActionableRules("CIを通してからマージすること")).toEqual(["CIを通してからマージすること"]);
  });

  test("rejects questions", () => {
    expect(extractActionableRules("Should we use TypeScript?")).toEqual([]);
    expect(extractActionableRules("これはバグですか？")).toEqual([]);
    expect(extractActionableRules("Why is the build so slow?")).toEqual([]);
  });

  test("rejects complaints and observations without actionable directive", () => {
    expect(extractActionableRules("The build is really slow")).toEqual([]);
    expect(extractActionableRules("I don't like this approach")).toEqual([]);
    expect(extractActionableRules("今日は疲れた")).toEqual([]);
    expect(extractActionableRules("ビルドが遅い")).toEqual([]);
  });

  test("splits multiple directives from a single message", () => {
    const rules = extractActionableRules("Always run lint before commit. Use Japanese for all reports.");
    expect(rules).toEqual([
      "Always run lint before commit",
      "Use Japanese for all reports",
    ]);
  });

  test("splits mixed content and extracts only actionable parts", () => {
    const rules = extractActionableRules("The build is slow. Always run tests before pushing. Why is CI broken?");
    expect(rules).toEqual(["Always run tests before pushing"]);
  });

  test("returns empty array for empty or whitespace input", () => {
    expect(extractActionableRules("")).toEqual([]);
    expect(extractActionableRules("   ")).toEqual([]);
  });
});

describe("extractObservationalContent", () => {
  test("extracts non-directive, non-question sentences", () => {
    expect(extractObservationalContent("The build is really slow")).toEqual(["The build is really slow"]);
    expect(extractObservationalContent("報告書出てこない")).toEqual(["報告書出てこない"]);
    expect(extractObservationalContent("ビルドが遅い")).toEqual(["ビルドが遅い"]);
  });

  test("returns empty for purely directive messages", () => {
    expect(extractObservationalContent("Always run lint before commit")).toEqual([]);
    expect(extractObservationalContent("テストを先に書くべき")).toEqual([]);
    expect(extractObservationalContent("Never skip code review")).toEqual([]);
  });

  test("returns empty for questions", () => {
    expect(extractObservationalContent("Should we use TypeScript?")).toEqual([]);
    expect(extractObservationalContent("これはバグですか？")).toEqual([]);
  });

  test("extracts only observational parts from mixed content", () => {
    const result = extractObservationalContent("The build is slow. Always run tests before pushing. Why is CI broken?");
    expect(result).toEqual(["The build is slow"]);
  });

  test("returns empty for empty or whitespace input", () => {
    expect(extractObservationalContent("")).toEqual([]);
    expect(extractObservationalContent("   ")).toEqual([]);
  });

  test("extracts multiple observations from one message", () => {
    const result = extractObservationalContent("ビルドが遅い。テストが落ちてる");
    expect(result).toEqual(["ビルドが遅い", "テストが落ちてる"]);
  });
});

describe("distillFeedback", () => {
  function tmpTemplatePath(): string {
    return join(tmpdir(), `worqload-template-test-${crypto.randomUUID()}.md`);
  }

  const sampleTemplate = `---
name: worqload
---

## Rules

- One task at a time.
- Small, incremental changes.
`;

  test("returns empty rules when no resolved feedback exists", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    await addFeedback("unresolved msg", "user1", feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(0);
    expect(result.rules).toEqual([]);

    // Template unchanged
    const content = await Bun.file(templatePath).text();
    expect(content).toBe(sampleTemplate);
  });

  test("extracts actionable rules from resolved feedback and appends to template", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb1 = await addFeedback("Always run lint before commit", "user1", feedbackPath);
    await addFeedback("unresolved msg", "user2", feedbackPath);
    const fb2 = await addFeedback("Use Japanese for all reports", "user1", feedbackPath);
    await resolveFeedback(fb1.id, feedbackPath);
    await resolveFeedback(fb2.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(2);
    expect(result.rules).toEqual([
      "Always run lint before commit",
      "Use Japanese for all reports",
    ]);

    // Template has new rules appended
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("- Always run lint before commit");
    expect(content).toContain("- Use Japanese for all reports");
    // Original rules preserved
    expect(content).toContain("- One task at a time.");
    expect(content).toContain("- Small, incremental changes.");
  });

  test("skips non-actionable resolved feedback without adding to template", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb1 = await addFeedback("The build is really slow", "user1", feedbackPath);
    const fb2 = await addFeedback("Why is CI broken?", "user1", feedbackPath);
    await resolveFeedback(fb1.id, feedbackPath);
    await resolveFeedback(fb2.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(0);
    expect(result.rules).toEqual([]);

    // Template unchanged
    const content = await Bun.file(templatePath).text();
    expect(content).toBe(sampleTemplate);
  });

  test("non-actionable resolved feedback is still removed from the store", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb1 = await addFeedback("The build is slow", "user1", feedbackPath);
    const fb2 = await addFeedback("stays unresolved", "user2", feedbackPath);
    await resolveFeedback(fb1.id, feedbackPath);

    await distillFeedback(feedbackPath, templatePath);

    const remaining = await loadFeedback(feedbackPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(fb2.id);
  });

  test("splits multi-directive feedback into individual rules", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests. Never skip linting.", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(2);
    expect(result.rules).toContain("Always run tests");
    expect(result.rules).toContain("Never skip linting");
  });

  test("does not add duplicate rules already in template", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    // "One task at a time." already exists in the template as a rule
    const fb = await addFeedback("Do one task at a time.", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(0);
    expect(result.rules).toEqual([]);

    // Template not modified
    const content = await Bun.file(templatePath).text();
    expect(content).toBe(sampleTemplate);
  });

  test("removes distilled feedback from the store", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb1 = await addFeedback("Always run tests", "user1", feedbackPath);
    const fb2 = await addFeedback("stays", "user2", feedbackPath);
    await resolveFeedback(fb1.id, feedbackPath);

    await distillFeedback(feedbackPath, templatePath);

    const remaining = await loadFeedback(feedbackPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(fb2.id);
  });

  test("does nothing when feedback store is empty", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const result = await distillFeedback(feedbackPath, templatePath);
    expect(result.distilledCount).toBe(0);
    expect(result.rules).toEqual([]);
  });

  test("throws when template file has no Rules section", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, "# No rules here\n\nSome content.\n");

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    expect(distillFeedback(feedbackPath, templatePath)).rejects.toThrow("Rules");
  });
});

describe("distilled rule tracking", () => {
  function tmpTemplatePath(): string {
    return join(tmpdir(), `worqload-template-test-${crypto.randomUUID()}.md`);
  }
  function tmpRulesPath(): string {
    return join(tmpdir(), `worqload-distilled-rules-test-${crypto.randomUUID()}.json`);
  }

  const sampleTemplate = `---
name: worqload
---

## Rules

- One task at a time.
- Small, incremental changes.
`;

  test("distillFeedback saves distilled rules to store with pending_verification status", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    const rulesPath = tmpRulesPath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run lint before commit", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const rules = await loadDistilledRules(rulesPath);
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe("Always run lint before commit");
    expect(rules[0].status).toBe("pending_verification");
    expect(rules[0].feedbackIds).toEqual([fb.id]);
    expect(rules[0].distilledAt).toBeDefined();
  });

  test("distillFeedback returns pendingVerification with created DistilledRule objects", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    const rulesPath = tmpRulesPath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests. Never skip linting.", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath, rulesPath);

    expect(result.pendingVerification).toHaveLength(2);
    expect(result.pendingVerification[0].rule).toBe("Always run tests");
    expect(result.pendingVerification[1].rule).toBe("Never skip linting");
    expect(result.pendingVerification.every(r => r.status === "pending_verification")).toBe(true);
  });

  test("distillFeedback does not create distilled rules when no actionable content", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    const rulesPath = tmpRulesPath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("The build is slow", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    const result = await distillFeedback(feedbackPath, templatePath, rulesPath);

    expect(result.pendingVerification).toHaveLength(0);
    const rules = await loadDistilledRules(rulesPath);
    expect(rules).toHaveLength(0);
  });

  test("distillFeedback returns empty pendingVerification when no resolved feedback", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    const rulesPath = tmpRulesPath();
    await Bun.write(templatePath, sampleTemplate);

    const result = await distillFeedback(feedbackPath, templatePath, rulesPath);
    expect(result.pendingVerification).toEqual([]);
  });

  test("loadDistilledRules returns empty array when no store exists", async () => {
    const rules = await loadDistilledRules(tmpRulesPath());
    expect(rules).toEqual([]);
  });

  test("verifyDistilledRules marks rules as verified when code changes exist", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const alwaysTrue = async () => true;
    const result = await verifyDistilledRules(rulesPath, alwaysTrue);

    expect(result.verified).toHaveLength(1);
    expect(result.unverified).toHaveLength(0);

    const stored = await loadDistilledRules(rulesPath);
    expect(stored[0].status).toBe("verified");
  });

  test("verifyDistilledRules keeps rules as pending when no code changes", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const alwaysFalse = async () => false;
    const result = await verifyDistilledRules(rulesPath, alwaysFalse);

    expect(result.verified).toHaveLength(0);
    expect(result.unverified).toHaveLength(1);

    const stored = await loadDistilledRules(rulesPath);
    expect(stored[0].status).toBe("pending_verification");
  });

  test("verifyDistilledRules skips already verified rules", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const alwaysTrue = async () => true;
    await verifyDistilledRules(rulesPath, alwaysTrue);

    // Verify again — should not re-process
    const alwaysFalse = async () => false;
    const result = await verifyDistilledRules(rulesPath, alwaysFalse);

    expect(result.verified).toHaveLength(0);
    expect(result.unverified).toHaveLength(0);
  });

  test("verifyDistilledRules verifies task_created rules when code changes exist", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const rules = await loadDistilledRules(rulesPath);
    await markRuleTaskCreated(rules[0].id, rulesPath);

    const alwaysTrue = async () => true;
    const result = await verifyDistilledRules(rulesPath, alwaysTrue);

    expect(result.verified).toHaveLength(1);
    expect(result.verified[0].status).toBe("verified");
    expect(result.unverified).toHaveLength(0);

    const stored = await loadDistilledRules(rulesPath);
    expect(stored[0].status).toBe("verified");
  });

  test("verifyDistilledRules excludes task_created rules from unverified list", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const rules = await loadDistilledRules(rulesPath);
    await markRuleTaskCreated(rules[0].id, rulesPath);

    const alwaysFalse = async () => false;
    const result = await verifyDistilledRules(rulesPath, alwaysFalse);

    expect(result.verified).toHaveLength(0);
    expect(result.unverified).toHaveLength(0);

    const stored = await loadDistilledRules(rulesPath);
    expect(stored[0].status).toBe("task_created");
  });

  test("markRuleTaskCreated transitions rule to task_created status", async () => {
    const rulesPath = tmpRulesPath();
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb = await addFeedback("Always run tests", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);
    await distillFeedback(feedbackPath, templatePath, rulesPath);

    const rules = await loadDistilledRules(rulesPath);
    await markRuleTaskCreated(rules[0].id, rulesPath);

    const updated = await loadDistilledRules(rulesPath);
    expect(updated[0].status).toBe("task_created");
  });
});

describe("sendFeedbackToProject", () => {
  function tmpProjectDir(): string {
    return join(tmpdir(), `worqload-proj-test-${crypto.randomUUID()}`);
  }

  function tmpProjectsPath(): string {
    return join(tmpdir(), `worqload-projects-test-${crypto.randomUUID()}.json`);
  }

  test("sends feedback to target project's feedback store", async () => {
    const projectsPath = tmpProjectsPath();
    const targetDir = tmpProjectDir();
    await Bun.write(join(targetDir, ".worqload", "feedback.json"), "[]");

    await registerProject(targetDir, "target-proj", projectsPath);

    const result = await sendFeedbackToProject("target-proj", "improve error handling", "source-proj", projectsPath);
    expect(result.message).toBe("improve error handling");
    expect(result.from).toBe("source-proj");
    expect(result.status).toBe("new");

    const targetFeedback = await loadFeedback(join(targetDir, ".worqload", "feedback.json"));
    expect(targetFeedback).toHaveLength(1);
    expect(targetFeedback[0].message).toBe("improve error handling");
    expect(targetFeedback[0].from).toBe("source-proj");
  });

  test("throws when target project is not registered", async () => {
    const projectsPath = tmpProjectsPath();
    expect(
      sendFeedbackToProject("nonexistent", "msg", "source", projectsPath)
    ).rejects.toThrow("Project not found: nonexistent");
  });

  test("creates feedback store if target project has none", async () => {
    const projectsPath = tmpProjectsPath();
    const targetDir = tmpProjectDir();
    // No .worqload directory exists yet

    await registerProject(targetDir, "new-proj", projectsPath);

    const result = await sendFeedbackToProject("new-proj", "hello from another project", "sender", projectsPath);
    expect(result.message).toBe("hello from another project");

    const targetFeedback = await loadFeedback(join(targetDir, ".worqload", "feedback.json"));
    expect(targetFeedback).toHaveLength(1);
  });

  test("appends to existing feedback in target project", async () => {
    const projectsPath = tmpProjectsPath();
    const targetDir = tmpProjectDir();
    const feedbackPath = join(targetDir, ".worqload", "feedback.json");
    await Bun.write(feedbackPath, "[]");

    await registerProject(targetDir, "target", projectsPath);

    await sendFeedbackToProject("target", "first", "projA", projectsPath);
    await sendFeedbackToProject("target", "second", "projB", projectsPath);

    const targetFeedback = await loadFeedback(feedbackPath);
    expect(targetFeedback).toHaveLength(2);
    expect(targetFeedback[0].message).toBe("first");
    expect(targetFeedback[1].message).toBe("second");
  });
});
