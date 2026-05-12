// The `Re: <path>:<lineStart>[-<lineEnd>]` line is how an anchored piece of
// feedback names the diff/file/report line it is about. The line lives only in
// the text the agent reads via `worqload feedback fetch`; the structured form
// (NumberedFileMeta.anchor) is the source of truth. These helpers translate
// between the two.

export interface AnchorRef {
  path: string;
  lineStart: number;
  lineEnd: number;
}

const ANCHOR_REF_RE = /^Re: (.+):(\d+)(?:-(\d+))?$/;

export function parseAnchorRefLine(line: string): AnchorRef | null {
  const m = line.match(ANCHOR_REF_RE);
  if (!m) return null;
  const lineStart = Number(m[2]);
  const lineEnd = m[3] !== undefined ? Number(m[3]) : lineStart;
  if (!Number.isInteger(lineStart) || lineStart < 1 || lineEnd < lineStart) return null;
  return { path: m[1], lineStart, lineEnd };
}

export function formatAnchorRefLine(anchor: AnchorRef): string {
  const range = anchor.lineEnd !== anchor.lineStart
    ? `${anchor.lineStart}-${anchor.lineEnd}`
    : `${anchor.lineStart}`;
  return `Re: ${anchor.path}:${range}`;
}
