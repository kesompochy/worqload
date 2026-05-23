// Files tab filename search (Ctrl/Cmd+Shift+P): a fuzzy finder over the worktree's
// flat path list. Pure so it's easy to test; FileNameSearchModal.svelte feeds
// it `state.files` and paints whatever paths come back. A query matches a path
// when its characters appear in order somewhere in the path (case-insensitive);
// the tightest match wins, basename hits beat directory-only hits, and ties
// break on path length then alphabetically.

const MAX_RESULTS = 200;

export function matchFilePaths(paths, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return { matches: [], truncated: false };
  const scored = [];
  for (const path of paths) {
    const score = scorePath(path, needle);
    if (score === null) continue;
    scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const truncated = scored.length > MAX_RESULTS;
  return { matches: scored.slice(0, MAX_RESULTS).map((entry) => entry.path), truncated };
}

function scorePath(path, needle) {
  const lower = path.toLowerCase();
  const baseStart = lower.lastIndexOf("/") + 1;
  const inBasename = subsequenceSpan(lower, needle, baseStart);
  if (inBasename) return inBasename.span;
  const anywhere = subsequenceSpan(lower, needle, 0);
  if (anywhere) return 1_000_000 + anywhere.span;
  return null;
}

// Locate `needle` as a subsequence of `haystack[from..]`, returning the span
// (count of characters covered) of a tight occurrence, or null if absent. We
// greedily take the earliest possible end, then greedily pull the start as far
// right as that end allows — good enough to favour contiguous matches.
function subsequenceSpan(haystack, needle, from) {
  let needleIndex = 0;
  let endIndex = -1;
  for (let i = from; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex++;
      endIndex = i;
    }
  }
  if (needleIndex < needle.length) return null;
  let backIndex = needle.length - 1;
  let startIndex = endIndex;
  for (let i = endIndex; i >= from && backIndex >= 0; i--) {
    if (haystack[i] === needle[backIndex]) {
      backIndex--;
      startIndex = i;
    }
  }
  return { span: endIndex - startIndex + 1 };
}
