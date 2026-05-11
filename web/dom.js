// Small DOM / formatting helpers shared across the worqload frontend modules.

export const $ = (sel) => document.querySelector(sel);

export function toast(text, ms = 2400) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

// Wire a textarea so a bare Enter submits and Shift+Enter inserts a newline.
export function bindEnterToSubmit(textarea, onSubmit) {
  if (!textarea) return;
  // Track IME composition explicitly. `event.isComposing` and `keyCode === 229`
  // cover most browsers, but on some macOS browsers the commit-Enter keydown
  // fires AFTER compositionend with both flags clear. The explicit flag is the
  // backstop so a confirming Enter does not also submit.
  let composing = false;
  textarea.addEventListener("compositionstart", () => { composing = true; });
  textarea.addEventListener("compositionend", () => { composing = false; });
  textarea.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (composing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSubmit();
  });
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatRelative(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
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
