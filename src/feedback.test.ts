import { test, expect, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedback, loadFeedback, acknowledgeFeedback, resolveFeedback, updateFeedbackMessage, summarizeFeedback, distillFeedback } from "./feedback";

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
  for (let i = 0; i < 7; i++) {
    await addFeedback(`msg${i}`, "user1", path);
  }
  const items = await loadFeedback(path);
  // resolve one
  items[0].status = "resolved";
  const summary = summarizeFeedback(items);
  // 6 unresolved, but only 5 returned (most recent first)
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
  expect(summary.themes[0]).toContain("alice");
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

  test("extracts resolved feedback messages as rules and appends to template", async () => {
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

  test("removes distilled feedback from the store", async () => {
    const feedbackPath = tmpPath();
    const templatePath = tmpTemplatePath();
    await Bun.write(templatePath, sampleTemplate);

    const fb1 = await addFeedback("rule A", "user1", feedbackPath);
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

    const fb = await addFeedback("rule", "user1", feedbackPath);
    await resolveFeedback(fb.id, feedbackPath);

    expect(distillFeedback(feedbackPath, templatePath)).rejects.toThrow("Rules");
  });
});
