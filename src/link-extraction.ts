const URL_RE = /https?:\/\/[^\s<>"')\]},]+/g;

// Trailing punctuation that is syntactically part of the surrounding prose
// (e.g. a period closing a sentence, a comma in a list) rather than part of
// the URL itself.  Stripped iteratively so "https://x.com/path)." loses both.
const TRAILING_JUNK_RE = /[.,;:!?)}\]]+$/;

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.matchAll(URL_RE)) {
    const url = raw[0].replace(TRAILING_JUNK_RE, "");
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}
