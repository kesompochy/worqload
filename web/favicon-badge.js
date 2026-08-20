// Overlay a notification-count badge on the browser favicon using an inline
// SVG data URL. The SVG approach avoids needing a Canvas / OffscreenCanvas
// (not always available in all runtimes) and keeps the module testable without
// a DOM.

const BADGE_SIZE = 32;

// Build an SVG data URL that draws a red circle with white text in the
// bottom-right corner of a `size × size` viewport. Returns null when count
// is zero or negative (meaning "no badge needed").
export function buildBadgeDataUrl(count, size) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const fontSize = label.length > 2 ? size * 0.32 : size * 0.42;
  const cx = size * 0.72;
  const cy = size * 0.28;
  const r = size * 0.28;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e53e3e"/>`,
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" `,
    `font-family="system-ui,sans-serif" font-weight="700" font-size="${fontSize}" fill="#fff">`,
    `${label}</text>`,
    `</svg>`,
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let originalHref = null;

// Update the <link rel="icon"> element to show a composite favicon: the
// original icon overlaid with a notification-count badge. When count is 0
// the original favicon is restored.
export function updateFaviconBadge(count) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (originalHref === null) originalHref = link.href;

  if (count <= 0) {
    link.href = originalHref;
    return;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = BADGE_SIZE;
    canvas.height = BADGE_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, BADGE_SIZE, BADGE_SIZE);

    const badgeUrl = buildBadgeDataUrl(count, BADGE_SIZE);
    if (!badgeUrl) return;
    const badge = new Image();
    badge.onload = () => {
      ctx.drawImage(badge, 0, 0, BADGE_SIZE, BADGE_SIZE);
      link.href = canvas.toDataURL("image/png");
    };
    badge.src = badgeUrl;
  };
  img.src = originalHref;
}
