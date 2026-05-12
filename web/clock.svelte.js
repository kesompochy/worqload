// A reactive wall clock that advances once a second. Relative timestamps in the
// detail pane (the Events tab rows, the Events tab-bar "· Ns ago" label) read
// `clock.now` so they keep counting up between streamed events; before, a 1s
// setInterval in app.js poked those nodes directly via DOM query.
// `startClock()` is called once from app.js — kept idempotent so a hot reload
// doesn't stack intervals.
export const clock = $state({ now: Date.now() });

let started = false;
export function startClock() {
  if (started) return;
  started = true;
  setInterval(() => { clock.now = Date.now(); }, 1_000);
}
