// Vite entry for the worqload frontend. Pulls in the stylesheet and the
// existing vanilla app, then mounts the Svelte components that have been
// migrated so far.
import "./style.css";
import "./app.js";
import { mount } from "svelte";
import { state } from "./state.svelte.js";
import NewSessionModal from "./svelte/NewSessionModal.svelte";
import FileSearchModal from "./svelte/FileSearchModal.svelte";
import CodeNavPopover from "./svelte/CodeNavPopover.svelte";
import FeedbackPreviewPopover from "./svelte/FeedbackPreviewPopover.svelte";
import FileNameSearchModal from "./svelte/FileNameSearchModal.svelte";
import SessionList from "./svelte/SessionList.svelte";
import DetailHeader from "./svelte/DetailHeader.svelte";
import DetailBody from "./svelte/DetailBody.svelte";
import Composer from "./svelte/Composer.svelte";

const newSessionModal = mount(NewSessionModal, { target: document.body });
document.getElementById("btnNew")?.addEventListener("click", () => newSessionModal.open());

// Ctrl/Cmd+Shift+F opens the Files-tab full-text search over the selected
// session's worktree; Ctrl/Cmd+Shift+P opens the filename search over the same
// files. The Shift variants avoid clobbering the browser's find-in-page (Cmd+F)
// and print (Cmd+P).
const fileSearchModal = mount(FileSearchModal, { target: document.body });
const fileNameSearchModal = mount(FileNameSearchModal, { target: document.body });
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
  if (!state.selected) return;
  const key = e.key.toLowerCase();
  if (key === "f") {
    e.preventDefault();
    fileSearchModal.open();
  } else if (key === "p") {
    e.preventDefault();
    fileNameSearchModal.open();
  }
});

// The Files-tab code-navigation popover (opened from a symbol-token click; see
// handlers.js / CodeNavPopover.svelte). On document.body so it floats freely.
mount(CodeNavPopover, { target: document.body });

// The anchored-feedback preview popover (opened on hover of a [data-feedback-preview]
// pin; see handlers.js / FeedbackPreviewPopover.svelte). On document.body so it floats.
mount(FeedbackPreviewPopover, { target: document.body });

const sessionListTarget = document.getElementById("sessionList");
if (sessionListTarget) mount(SessionList, { target: sessionListTarget });

const detailHeaderTarget = document.getElementById("detailHeader");
if (detailHeaderTarget) mount(DetailHeader, { target: detailHeaderTarget });

const detailBodyTarget = document.getElementById("detailBodyMount");
if (detailBodyTarget) mount(DetailBody, { target: detailBodyTarget });

const detailComposerTarget = document.getElementById("detailComposer");
if (detailComposerTarget) mount(Composer, { target: detailComposerTarget });
