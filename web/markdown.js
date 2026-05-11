// Minimal markdown renderer for worqload report / asking / feedback bodies.
//
// Supported block syntax:
//   - ATX headings (# .. ######)
//   - Fenced code blocks (``` ... ```)
//   - Blockquotes (> ...)
//   - Unordered lists (-, *, +)
//   - Ordered lists (1.  2.  ...)
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
  };
  return blocks.map(b => renderBlock(b, ctx)).join("");
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

function consumeParagraph(lines, start, out) {
  const startLine = start + 1;
  const body = [];
  let i = start;
  while (i < lines.length && !paragraphEnds(lines[i])) {
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

function paragraphEnds(line) {
  return isBlankLine(line)
      || isFenceLine(line)
      || isHeadingLine(line)
      || isHrLine(line)
      || isBlockquoteLine(line)
      || isUnorderedListItem(line)
      || isOrderedListItem(line);
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
  return `<pre${attrs}><code${langAttr}>${escapeHtml(block.content)}</code></pre>`;
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

  // Links: [text](url "title")
  s = s.replace(
    /\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
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
  return ` data-anchor-path="${escapeAttr(ctx.anchorPath)}"`
       + ` data-anchor-line="${startLine}"`
       + ` data-anchor-line-end="${endLine}"`
       + selected;
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
