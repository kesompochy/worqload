// The whole session detail pane is now Svelte: DetailHeader.svelte (header /
// meta line / tab bar), ActionBar.svelte (action bar + action panels),
// DetailBody.svelte (the scroll body — pending-asking section, active tab,
// "Feedback sent" list) and Composer.svelte (the feedback / resume composer),
// each mounted from main.ts; the sidebar is SessionList.svelte. They all
// re-render reactively off `state`.
//
// These stay exported because api.js and handlers.js still call them as their
// "the session list / detail changed" signal — those mutations already update
// `state`, so there is nothing left to do here. The calls (and this file) get
// cleaned up once main.ts is the only thing wiring the frontend.

export function renderSessionList() {}

export function renderDetail() {}
