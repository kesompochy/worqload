// Minimal markdown renderer for worqload report / asking / feedback bodies.
//
// Supported block syntax:
//   - ATX headings (# .. ######)
//   - Fenced code blocks (``` ... ```)
//   - Blockquotes (> ...)
//   - Unordered lists (-, *, +)
//   - Ordered lists (1.  2.  ...)
//   - GFM tables (| a | b | + a |---|---| delimiter row, with :--: alignment)
//   - Horizontal rules (---, ***, ___)
//   - Paragraphs
//
// Supported inline syntax:
//   - Bold (**text**), italic (*text* / _text_)
//   - Inline code (`code`)
//   - Links ([text](url))
//
// Each block-level element emits source-line metadata so the worqload UI can
// anchor feedback at the original markdown line, even though the rendering
// is HTML:
//   data-anchor-path     = anchorPath passed by caller
//   data-anchor-line     = 1-based start line in the source
//   data-anchor-line-end = 1-based end line in the source

// Sentinel for stashing inline-code spans during inline rendering. Chosen
// from the Unicode private-use area so it cannot legitimately appear in
// agent reports or human feedback.
const CODE_SENTINEL = "";

// ---------- public API ----------

export function renderMarkdown(source, options = {}) {
  const blocks = parseBlocks(source);
  const ctx = {
    anchorPath: options.anchorPath ?? null,
    currentAnchor: options.anchor ?? null,
    // [{ lineStart, lineEnd, filename }] — sent feedback anchored into this
    // source; blocks overlapping a range get a data-feedback-preview attr.
    feedbackAnchors: options.feedbackAnchors ?? [],
  };
  return blocks.map(b => renderBlock(b, ctx)).join("");
}

// The ATX headings of `source`, in document order, for building a table of
// contents. `line` is the 1-based source line of the heading — the same value
// `renderMarkdown` puts on the rendered `<h*>`'s data-anchor-line, so a TOC
// entry can drive the existing line-anchor scroll. `text` is the heading with
// inline markdown reduced to its visible text. Headings inside fenced code
// blocks are excluded because parseBlocks consumes those fences first.
export function extractHeadings(source) {
  return parseBlocks(source)
    .filter(b => b.kind === "heading")
    .map(b => ({ level: b.level, text: stripInlineMarkdown(b.content), line: b.startLine }));
}

// Reduce heading inline markdown to plain text for a TOC label. Mirrors the
// constructs renderInline handles (code, links, bold, italic) but keeps only
// the visible text. Code spans are unwrapped first so emphasis markers inside
// them are not stripped.
function stripInlineMarkdown(text) {
  return String(text ?? "")
    .replace(/`+([^`]+?)`+/g, "$1")
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- block-level parsing ----------

function parseBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }

    if (isFenceLine(line)) { i = consumeFencedCode(lines, i, blocks); continue; }
    if (isHeadingLine(line)) { i = consumeHeading(lines, i, blocks); continue; }
    if (isHrLine(line)) { i = consumeHr(lines, i, blocks); continue; }
    if (isBlockquoteLine(line)) { i = consumeBlockquote(lines, i, blocks); continue; }
    if (isUnorderedListItem(line)) { i = consumeUnorderedList(lines, i, blocks); continue; }
    if (isOrderedListItem(line)) { i = consumeOrderedList(lines, i, blocks); continue; }
    if (isTableStart(lines, i)) { i = consumeTable(lines, i, blocks); continue; }

    i = consumeParagraph(lines, i, blocks);
  }
  return blocks;
}

function isBlankLine(line) { return /^\s*$/.test(line); }
function isFenceLine(line) { return /^```/.test(line); }
function isHeadingLine(line) { return /^#{1,6}\s+/.test(line); }
function isHrLine(line) {
  if (!/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return false;
  return line.replace(/\s/g, "").length >= 3;
}
function isBlockquoteLine(line) { return /^>\s?/.test(line); }
function isUnorderedListItem(line) { return /^[-*+]\s+/.test(line); }
function isOrderedListItem(line) { return /^\d+\.\s+/.test(line); }
function isListContinuation(line) { return /^\s{2,}\S/.test(line); }

// A GFM table starts where a header row (which must contain at least one pipe,
// so a lone "---" stays a horizontal rule) is immediately followed by a
// delimiter row such as "| :-- | --: |".
function isTableStart(lines, i) {
  const line = lines[i];
  if (line === undefined || isBlankLine(line) || !line.includes("|")) return false;
  if (!isTableDelimiterRow(lines[i + 1])) return false;
  // GFM requires the header and delimiter rows to have the same column count.
  return splitTableRow(line).length === splitTableRow(lines[i + 1]).length;
}

function isTableDelimiterRow(line) {
  if (line === undefined) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell));
}

// Body rows run until a blank line or the start of another block-level element.
function isTableBodyRow(line) {
  if (line === undefined || isBlankLine(line)) return false;
  return !isFenceLine(line)
      && !isHeadingLine(line)
      && !isHrLine(line)
      && !isBlockquoteLine(line)
      && !isUnorderedListItem(line)
      && !isOrderedListItem(line);
}

function consumeFencedCode(lines, start, out) {
  const startLine = start + 1;
  const lang = lines[start].slice(3).trim();
  const body = [];
  let i = start + 1;
  while (i < lines.length && !isFenceLine(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  const endLine = i < lines.length ? i + 1 : i;  // include the closing fence if present
  if (i < lines.length) i++;                     // skip closing fence
  out.push({ kind: "code", lang, content: body.join("\n"), startLine, endLine });
  return i;
}

function consumeHeading(lines, start, out) {
  const m = lines[start].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
  out.push({
    kind: "heading",
    level: m[1].length,
    content: m[2],
    startLine: start + 1,
    endLine: start + 1,
  });
  return start + 1;
}

function consumeHr(_lines, start, out) {
  out.push({ kind: "hr", startLine: start + 1, endLine: start + 1 });
  return start + 1;
}

function consumeBlockquote(lines, start, out) {
  const startLine = start + 1;
  const body = [];
  let i = start;
  while (i < lines.length && isBlockquoteLine(lines[i])) {
    body.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  out.push({
    kind: "blockquote",
    content: body.join("\n"),
    startLine,
    endLine: i,
  });
  return i;
}

function consumeUnorderedList(lines, start, out) {
  return consumeList(lines, start, out, "ul", /^[-*+]\s+/);
}

function consumeOrderedList(lines, start, out) {
  return consumeList(lines, start, out, "ol", /^\d+\.\s+/);
}

function consumeList(lines, start, out, kind, markerRe) {
  const startLine = start + 1;
  const items = [];
  let i = start;
  while (i < lines.length && markerRe.test(lines[i])) {
    const itemStartLine = i + 1;
    let content = lines[i].replace(markerRe, "");
    i++;
    while (i < lines.length && isListContinuation(lines[i])) {
      content += "\n" + lines[i].replace(/^\s+/, "");
      i++;
    }
    items.push({ content, startLine: itemStartLine, endLine: i });
  }
  out.push({ kind, items, startLine, endLine: i });
  return i;
}

function consumeTable(lines, start, out) {
  const startLine = start + 1;
  const headerCells = splitTableRow(lines[start]);
  const aligns = parseTableAlignments(lines[start + 1]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && isTableBodyRow(lines[i])) {
    rows.push({ cells: splitTableRow(lines[i]), line: i + 1 });
    i++;
  }
  out.push({
    kind: "table",
    headerCells,
    aligns,
    rows,
    // The header element is anchored to both the header and delimiter source lines.
    headerStartLine: startLine,
    headerEndLine: start + 2,
    startLine,
    endLine: i,
  });
  return i;
}

// Split a table row into trimmed cell contents. Leading and trailing pipes are
// optional; a backslash-escaped pipe (\|) stays inside its cell.
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.slice(0, -1).endsWith("\\")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}

function parseTableAlignments(delimiterLine) {
  return splitTableRow(delimiterLine).map(cell => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function consumeParagraph(lines, start, out) {
  const startLine = start + 1;
  const body = [];
  let i = start;
  while (i < lines.length && !paragraphEnds(lines, i)) {
    body.push(lines[i]);
    i++;
  }
  out.push({
    kind: "paragraph",
    content: body.join("\n"),
    startLine,
    endLine: i,
  });
  return i;
}

function paragraphEnds(lines, i) {
  const line = lines[i];
  return isBlankLine(line)
      || isFenceLine(line)
      || isHeadingLine(line)
      || isHrLine(line)
      || isBlockquoteLine(line)
      || isUnorderedListItem(line)
      || isOrderedListItem(line)
      || isTableStart(lines, i);
}

// ---------- block-level rendering ----------

function renderBlock(block, ctx) {
  switch (block.kind) {
    case "heading":    return renderHeading(block, ctx);
    case "paragraph":  return renderParagraph(block, ctx);
    case "code":       return renderCode(block, ctx);
    case "hr":         return renderHr(block, ctx);
    case "blockquote": return renderBlockquote(block, ctx);
    case "ul":         return renderList("ul", block, ctx);
    case "ol":         return renderList("ol", block, ctx);
    case "table":      return renderTable(block, ctx);
    default:           return "";
  }
}

function renderHeading(block, ctx) {
  const attrs = anchorAttrs(block.startLine, block.endLine, ctx);
  return `<h${block.level}${attrs}>${renderInline(block.content)}</h${block.level}>`;
}

function renderParagraph(block, ctx) {
  const attrs = anchorAttrs(block.startLine, block.endLine, ctx);
  return `<p${attrs}>${renderInline(block.content)}</p>`;
}

function renderCode(block, ctx) {
  const attrs = anchorAttrs(block.startLine, block.endLine, ctx);
  const langAttr = block.lang ? ` class="language-${escapeAttr(block.lang)}"` : "";
  // The button is a sibling of the `<pre>` rather than a child so the line-anchor
  // and feedback-preview attributes (which onLineClick / hover delegation read off
  // the closest `[data-anchor-line]` / `[data-feedback-preview]`) stay on the
  // `<pre>` and aren't reached through the button. The handler reads the raw
  // text off the inner `<code>`'s textContent — no second escape pass needed.
  return `<div class="md-code-block">`
       + `<pre${attrs}><code${langAttr}>${escapeHtml(block.content)}</code></pre>`
       + `<button type="button" class="md-code-copy-btn" data-copy-code title="コードをコピー">⧉</button>`
       + `</div>`;
}

function renderHr(block, ctx) {
  const attrs = anchorAttrs(block.startLine, block.endLine, ctx);
  return `<hr${attrs}>`;
}

function renderBlockquote(block, ctx) {
  const attrs = anchorAttrs(block.startLine, block.endLine, ctx);
  // We do not recurse into the quote body; rendering it as a single paragraph
  // keeps the renderer simple and covers the typical agent-report use.
  return `<blockquote${attrs}><p>${renderInline(block.content)}</p></blockquote>`;
}

function renderList(tag, block, ctx) {
  const items = block.items.map(item => {
    const attrs = anchorAttrs(item.startLine, item.endLine, ctx);
    return `<li${attrs}>${renderInline(item.content)}</li>`;
  }).join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderTable(block, ctx) {
  const cell = (tag, content, columnIndex) => {
    const align = block.aligns[columnIndex];
    const style = align ? ` style="text-align:${align};"` : "";
    return `<${tag}${style}>${renderInline(content)}</${tag}>`;
  };
  const columnCount = block.headerCells.length;
  const headerAttrs = anchorAttrs(block.headerStartLine, block.headerEndLine, ctx);
  const headerRow = `<tr${headerAttrs}>`
    + block.headerCells.map((content, i) => cell("th", content, i)).join("")
    + `</tr>`;
  const bodyRows = block.rows.map(row => {
    const attrs = anchorAttrs(row.line, row.line, ctx);
    let cells = "";
    for (let i = 0; i < columnCount; i++) cells += cell("td", row.cells[i] ?? "", i);
    return `<tr${attrs}>${cells}</tr>`;
  }).join("");
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

// ---------- inline rendering ----------

function renderInline(text) {
  // Stash inline-code spans first so their bodies are not touched by emphasis
  // or link rules.
  const codePlaceholders = [];
  let s = text.replace(/`+([^`]+?)`+/g, (_, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_SENTINEL}${idx}${CODE_SENTINEL}`;
  });

  s = escapeHtml(s);

  // Links: [text](url "title"). escapeHtml above leaves '"' untouched, so the
  // title delimiter is still a literal double quote at this point.
  s = s.replace(
    /\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g,
    (_, body, url, title) => {
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(url)}"${titleAttr} rel="noreferrer" target="_blank">${body}</a>`;
    },
  );

  // Bold before italic so the inner '*' is consumed first.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  // _italic_ requires word boundaries so identifiers like foo_bar_baz are not mangled.
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");

  const codeRe = new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, "g");
  s = s.replace(codeRe, (_, idx) => codePlaceholders[Number(idx)]);
  return s;
}

// ---------- attribute helpers ----------

function anchorAttrs(startLine, endLine, ctx) {
  if (!ctx.anchorPath) return "";
  const selected = isOverlap(startLine, endLine, ctx.currentAnchor, ctx.anchorPath)
    ? ` aria-current="true"`
    : "";
  // `data-feedback-preview` both draws the left stripe (CSS) and carries the
  // comma-joined filenames of the sent feedback anchored over this block;
  // hovering the block surfaces the 💬 pin / preview popover (see handlers.js /
  // AnchoredFeedbackOverlay.svelte). The diff and file views set the same attr.
  const names = feedbackAnchorsOverlapping(startLine, endLine, ctx).map(f => f.filename);
  const feedbackAttr = names.length > 0 ? ` data-feedback-preview="${escapeAttr(names.join(","))}"` : "";
  return ` data-anchor-path="${escapeAttr(ctx.anchorPath)}"`
       + ` data-anchor-line="${startLine}"`
       + ` data-anchor-line-end="${endLine}"`
       + selected
       + feedbackAttr;
}

function feedbackAnchorsOverlapping(startLine, endLine, ctx) {
  return ctx.feedbackAnchors.filter(a => startLine <= a.lineEnd && endLine >= a.lineStart);
}

function isOverlap(startLine, endLine, anchor, anchorPath) {
  if (!anchor || anchor.path !== anchorPath) return false;
  return startLine <= anchor.lineEnd && endLine >= anchor.lineStart;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
