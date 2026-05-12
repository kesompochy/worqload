// Renders the inline panel for a "gh action". The actions deliberately use an
// inline panel rather than a modal: the run log stays on screen alongside the
// rest of the session, and (because the server records each run as an
// action_invoked event) it survives a reload. The confirmation step is the
// explicit "Confirm & Run" button, kept in the panel head — directly under the
// action bar — so it is a short reach from the button that opened the panel.
// The panel is the gate, not a separate dialog.

import { escapeHtml, formatRelative } from "./dom.js";
import { state } from "./state.svelte.js";

export function renderActionPanelHtml() {
  const action = state.actions.find(a => a.id === state.openActionId);
  if (!action) return "";
  const paramsHtml = (action.params || []).map(p => {
    const fieldId = `actionParam-${p.name}`;
    const dataAttr = `data-action-param="${escapeHtml(p.name)}"`;
    if (p.type === "text") {
      return `
        <label for="${fieldId}">${escapeHtml(p.label)}</label>
        <textarea id="${fieldId}" ${dataAttr} rows="4" placeholder="${escapeHtml(p.placeholder || "")}">${escapeHtml(p.default || "")}</textarea>
      `;
    }
    return `
      <label for="${fieldId}">${escapeHtml(p.label)}</label>
      <input id="${fieldId}" ${dataAttr} type="text" placeholder="${escapeHtml(p.placeholder || "")}" value="${escapeHtml(p.default || "")}">
    `;
  }).join("");
  const confirmHtml = action.confirmMessage
    ? `<div class="action-confirm">⚠ ${escapeHtml(action.confirmMessage)}</div>`
    : "";
  return `
    <div class="action-panel">
      <div class="action-panel-head">
        <strong>${escapeHtml(action.label)}</strong>
        <button class="action-run" data-action-panel-run>${action.confirmMessage ? "Confirm &amp; Run" : "Run"}</button>
        ${action.description ? `<span class="desc">${escapeHtml(action.description)}</span>` : ""}
        <span class="spacer"></span>
        <button class="close" data-action-panel-close title="Close">×</button>
      </div>
      ${confirmHtml}
      ${paramsHtml ? `<div class="action-form">${paramsHtml}</div>` : ""}
      <div class="action-output">${renderActionOutputHtml(action.id)}</div>
    </div>
  `;
}

// Newest run for an action: the in-view cache (freshest, populated by runOpenAction)
// falls back to the latest action_invoked event so a run made before this page
// load is still shown when the panel is opened.
function lastRunFor(actionId) {
  const cached = state.actionResults.get(actionId);
  if (cached) return cached;
  const events = state.detail?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === "action_invoked" && ev.payload && ev.payload.actionId === actionId) {
      return { ...ev.payload, ranAt: ev.timestamp };
    }
  }
  return null;
}

function renderActionOutputHtml(actionId) {
  const r = lastRunFor(actionId);
  if (!r) {
    return `<div class="empty">No run yet — press Run above. Past runs stay here and in the Events tab.</div>`;
  }
  const ranAt = r.ranAt ? `<span class="ran-at">${formatRelative(r.ranAt)}</span>` : "";
  const statusLine = r.ok
    ? `<div class="status-ok">✓ Success (exit ${r.exitCode ?? 0})${ranAt}</div>`
    : `<div class="status-fail">✗ Failed${r.exitCode !== undefined && r.exitCode !== null ? ` (exit ${r.exitCode})` : ""}${ranAt}</div>`;
  const messageLine = r.message ? `<div style="margin-top:.3rem">${escapeHtml(r.message)}</div>` : "";
  const stdout = r.stdout && r.stdout.trim() !== "" ? `<h3>stdout</h3><pre>${escapeHtml(r.stdout)}</pre>` : "";
  const stderr = r.stderr && r.stderr.trim() !== "" ? `<h3>stderr</h3><pre>${escapeHtml(r.stderr)}</pre>` : "";
  return `${statusLine}${messageLine}${stdout}${stderr}`;
}
