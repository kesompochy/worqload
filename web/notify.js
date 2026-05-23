// Browser glue for desktop notifications. The "what should the toast say"
// logic is pure and lives in notifications.js; this module owns the side of it
// that touches the browser: the Notification permission, the bell toggle, the
// localStorage preference, and actually calling `new Notification(...)`.

import { $, toast } from "./dom.js";
import { state } from "./state.svelte.js";
import { selectSession, revealReport } from "./handlers.js";

// Desktop notifications for new reports and escalations. The preference is a
// localStorage flag; notifications fire only when it's on AND the browser has
// granted permission. Default-on once permission is granted, so the bell is a
// single toggle rather than a two-step opt-in.
const NOTIFY_PREF_KEY = "worqload:notifications";

export const notify = {
  supported: typeof window !== "undefined" && "Notification" in window,
  get permission() { return this.supported ? Notification.permission : "unsupported"; },
  prefOn() { return localStorage.getItem(NOTIFY_PREF_KEY) !== "off"; },
  setPref(on) { localStorage.setItem(NOTIFY_PREF_KEY, on ? "on" : "off"); },
  active() { return this.supported && this.permission === "granted" && this.prefOn(); },
};

export function fireNotification({ title, body, tag, sessionId }) {
  if (!notify.active()) return;
  let n;
  try { n = new Notification(title, { body, tag }); } catch { return; }
  n.onclick = () => {
    window.focus();
    // Report notifications land you on the Reports tab with that report opened;
    // the tag — worqload:report:<sessionId>[:<filename>] (see notifications.js) —
    // is the only handle on which report. Everything else just shows the session.
    const reportTag = /^worqload:report:[^:]+(?::(.+))?$/.exec(tag || "");
    if (reportTag) revealReport(sessionId, reportTag[1] || null);
    else if (sessionId && sessionId !== state.selected) selectSession(sessionId);
    n.close();
  };
}

export function syncNotifyButton() {
  const btn = $("#btnNotify");
  if (!btn) return;
  if (!notify.supported) { btn.style.display = "none"; return; }
  const p = notify.permission;
  if (p === "granted" && notify.prefOn()) {
    btn.textContent = "🔔";
    btn.className = "btn-notify on";
    btn.title = "Desktop notifications: on (reports & escalations) — click to mute";
  } else if (p === "denied") {
    btn.textContent = "🔕";
    btn.className = "btn-notify off";
    btn.title = "Desktop notifications blocked in browser settings";
  } else {
    btn.textContent = "🔕";
    btn.className = "btn-notify off";
    btn.title = p === "granted"
      ? "Desktop notifications: off — click to enable"
      : "Click to enable desktop notifications";
  }
}

export async function onNotifyClick() {
  if (!notify.supported) return;
  const p = notify.permission;
  if (p === "denied") { toast("Notifications are blocked — enable them in your browser settings"); return; }
  if (p === "default") {
    let result;
    try { result = await Notification.requestPermission(); } catch { result = notify.permission; }
    if (result === "granted") { notify.setPref(true); toast("Desktop notifications on"); }
    else if (result === "denied") { toast("Notifications denied"); }
    syncNotifyButton();
    return;
  }
  const next = !notify.prefOn();
  notify.setPref(next);
  toast(next ? "Desktop notifications on" : "Desktop notifications muted");
  syncNotifyButton();
}
