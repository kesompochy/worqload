// Small DOM / formatting helpers shared across the worqload frontend modules.

export const $ = (sel) => document.querySelector(sel);

export function toast(text, ms = 2400) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// Wire a single-line edit input: a non-composing Enter commits, Escape cancels.
// IME composition is tracked explicitly: `event.isComposing` and
// `keyCode === 229` cover most browsers, but on some macOS browsers the
// commit-Enter keydown fires after compositionend with both flags clear, so
// the explicit flag is the backstop. (The browser's native prompt() has no
// such guard, so a confirming Enter mid-IME also "submits" the dialog; this
// avoids that.)
export function bindInlineEdit(input, { onCommit, onCancel }) {
  if (!input) return;
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "Enter") { e.preventDefault(); onCommit(); }
  });
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// `now` defaults to the wall clock; callers that want the label to tick (the
// Events UI) pass a reactive timestamp so Svelte re-derives once a second.
export function formatRelative(iso, now = Date.now()) {
  if (!iso) return "";
  const diff = (now - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
