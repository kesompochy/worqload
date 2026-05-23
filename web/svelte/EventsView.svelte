<script>
  // The Events tab's body: the session's NDJSON event stream, newest first,
  // each event one line until clicked open. Mounted by DetailBody.svelte. The
  // line/section content comes from describeEvent (pure, in events-view.js) off
  // the reactive event list; this component only paints it. The line keeps the
  // data-event-toggle / data-event-seq hooks that handlers.js's onDetailBodyClick
  // delegates on (expand/collapse) and that DetailBody's scroll-capture effect
  // anchors to when a new event prepends — there are no local click handlers.
  // (`state` is imported as `appState`: a local `state` binding would make
  // Svelte read `$state` as a store subscription, not the rune.)
  import { state as appState, isEventExpanded } from "../state.svelte.js";
  import { formatRelative } from "../dom.js";
  import { renderMarkdown } from "../markdown.js";
  import { describeEvent, displayEventKind, isAgentWorkEvent } from "../events-view.js";
  import { clock } from "../clock.svelte.js";

  // Only the agent's own work — reports, feedback, escalations and
  // human-triggered actions belong to the Reports / Feedbacks tabs, not here.
  const eventsNewestFirst = $derived((appState.detail?.events ?? []).filter(isAgentWorkEvent).reverse());
</script>

{#if eventsNewestFirst.length === 0}
  <div class="diff-empty">No events yet.</div>
{:else}
  {#each eventsNewestFirst as event (event.seq)}
    {@const described = describeEvent(event)}
    <div class="event-row" class:expanded={isEventExpanded(event)} data-event-seq={event.seq}>
      <div class="event-line" data-event-toggle={event.seq}>
        <span class="event-chevron">▾</span>
        <span class="event-seq">{event.seq}</span>
        <span class="event-kind" title={event.kind}>{displayEventKind(event, appState.detail?.agentName)}</span>
        <span class="event-ts">{formatRelative(event.timestamp, clock.now)}</span>
        <span class="event-summary">{described.summary}</span>
      </div>
      <div class="event-detail">
        {#each described.sections as section}
          <div class="event-section-label">{section.label}</div>
          {#if section.format === "markdown"}
            <div class="md">{@html renderMarkdown(String(section.body ?? ""))}</div>
          {:else if section.format === "text"}
            <div class="event-section-text">{section.body}</div>
          {:else}
            <pre class="event-section-code">{section.body}</pre>
          {/if}
        {/each}
      </div>
    </div>
  {/each}
{/if}
