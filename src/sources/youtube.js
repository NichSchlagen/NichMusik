// src/music/sources/youtube.js
// Hilfsfunktionen zum Bereinigen von YouTube-Links für Lavalink-Anfragen.

/**
 * Normalisiert YouTube-Links auf ein einzelnes Video:
 * - entfernt &list, &start_radio, &index, &t, etc.
 * - unterstützt youtu.be, watch, shorts, embed
 * - lässt Nicht-YouTube-URLs und Suchstrings unverändert
 */
export function normalizeYouTubeUrl(input) {
  if (!input || typeof input !== "string") return input;

  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);

    if (!isYouTubeHost(url.hostname)) return input;

    // 1) youtu.be/<id>
    if (isShortHost(url.hostname)) {
      const id = url.pathname.replace("/", "");
      return id ? buildWatchUrl(id) : input;
    }

    // 2) youtube.com/watch?v=<id>
    const v = url.searchParams.get("v");
    if (v) return buildWatchUrl(v);

    // 3) youtube.com/shorts/<id>
    const shortsId = matchPathId(url.pathname, "/shorts/");
    if (shortsId) return buildWatchUrl(shortsId);

    // 4) youtube.com/embed/<id>
    const embedId = matchPathId(url.pathname, "/embed/");
    if (embedId) return buildWatchUrl(embedId);

    // sonst: unbekanntes Format -> nicht anfassen
    return input;
  } catch {
    // kein URL (z.B. Suchtext) -> nicht anfassen
    return input;
  }
}

/**
 * Wandelt freie Text-Queries in ein ytsearch: Präfix um, lässt aber echte URLs
 * oder bereits prefixte Identifer unverändert.
 */
export function buildYouTubeQuery(input) {
  const normalized = normalizeYouTubeUrl(input);
  if (!normalized || typeof normalized !== "string") return normalized;

  const trimmed = normalized.trim();
  if (!trimmed) return trimmed;

  // Bereits ein expliziter Suchstring oder eine URL? Dann nicht verändern.
  if (trimmed.startsWith("ytsearch:")) return trimmed;
  if (trimmed.startsWith("ytmsearch:")) return trimmed;
  if (looksLikeUrl(trimmed)) return trimmed;

  return `ytsearch:${trimmed}`;
}

function buildWatchUrl(videoId) {
  // nur die Video-ID mitnehmen, sonst nix
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function isYouTubeHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === "youtu.be" ||
    h === "youtube.com" ||
    h.endsWith(".youtube.com") || // www., m., music., etc.
    h === "www.youtube.com" ||
    h === "m.youtube.com" ||
    h === "music.youtube.com"
  );
}

function isShortHost(hostname) {
  return hostname.toLowerCase() === "youtu.be";
}

function matchPathId(pathname, prefix) {
  const idx = pathname.indexOf(prefix);
  if (idx === -1) return null;
  const rest = pathname.slice(idx + prefix.length);
  const id = rest.split("/")[0];
  return id || null;
}

function looksLikeUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
