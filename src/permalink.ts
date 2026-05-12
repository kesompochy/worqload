// Turns a git remote URL plus a commit sha into a GitHub-style "permalink" blob
// URL (https://<host>/<owner>/<repo>/blob/<sha>/<path>#L<n>). worqload couples
// to git only for the remote URL and HEAD sha — building the browser URL is
// pure string work, kept here so it's testable without a repo.
//
// "GitHub-style" covers GitHub.com and GitHub Enterprise, which share this path
// shape. GitHub Enterprise runs on arbitrary hostnames, so we can't tell a GHES
// host from a self-hosted GitLab by the remote URL alone; we assume GitHub
// shape for any host and only carve out the public hosts whose shape we know
// differs (GitLab's /-/blob/, Bitbucket's /src/).
const HOSTS_WITH_INCOMPATIBLE_BLOB_URLS = new Set(["gitlab.com", "bitbucket.org"]);

export interface ParsedRemoteRepo {
  // The repo's web root, e.g. "https://github.com/owner/repo" — no trailing
  // slash, no ".git".
  webBaseUrl: string;
}

// Recognizes the remote URL forms `git remote get-url` emits:
//   git@host:owner/repo(.git)            (scp-like, the usual SSH form)
//   ssh://git@host[:port]/owner/repo(.git)
//   https://host/owner/repo(.git)  /  http://...
// "owner/repo" may be a deeper path (GHES/GitLab subgroups) — anything after the
// host up to a trailing ".git" is kept. Returns null for local paths,
// unrecognized schemes, and the hosts whose blob URL shape differs.
export function parseGitRemoteUrl(remoteUrl: string): ParsedRemoteRepo | null {
  const trimmed = remoteUrl.trim();
  if (trimmed === "") return null;

  let host: string;
  let path: string;

  const scpLike = trimmed.match(/^[^/@]+@([^/:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol !== "ssh:" && url.protocol !== "https:" && url.protocol !== "http:") return null;
    host = url.hostname;
    path = url.pathname.replace(/^\/+/, "");
  }

  if (HOSTS_WITH_INCOMPATIBLE_BLOB_URLS.has(host)) return null;
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (path === "" || !path.includes("/")) return null;

  return { webBaseUrl: `https://${host}/${path}` };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function buildBlobPermalink(params: {
  webBaseUrl: string;
  ref: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}): string {
  const { webBaseUrl, ref, path, lineStart, lineEnd } = params;
  let url = `${webBaseUrl}/blob/${ref}/${encodePath(path)}`;
  if (lineStart !== undefined) {
    url += lineEnd !== undefined && lineEnd > lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
  }
  return url;
}
