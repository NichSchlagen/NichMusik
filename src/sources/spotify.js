// src/sources/spotify.js
// Spotify-Helper mit Fallback auf YouTube-Suche, falls der Lavalink-Node
// keine Spotify-Integration besitzt.

const OEMBED_ENDPOINT = "https://open.spotify.com/oembed?url=";

export function isSpotifyUrl(input) {
  if (!input || typeof input !== "string") return false;

  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase();
    return host === "open.spotify.com" || host.endsWith(".spotify.com");
  } catch {
    return false;
  }
}

export function normalizeSpotifyUrl(input) {
  try {
    const url = new URL(input.trim());

    // Erkenne Spotify-Hosts (inkl. Subdomains) und standardisiere auf das
    // klassische open.spotify.com-Format, damit Lavalink die URL akzeptiert.
    const host = url.hostname.toLowerCase();
    if (host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
      return input;
    }

    const normalized = new URL(url.toString());
    normalized.protocol = "https:";
    normalized.hostname = "open.spotify.com";

    // Locale-Prefixe wie /intl-de/ verursachen Probleme. Entferne sie, sodass
    // z.B. /intl-de/track/... zu /track/... wird.
    const parts = normalized.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("intl-")) parts.shift();
    normalized.pathname = `/${parts.join("/")}`;

    return normalized.toString();
  } catch {
    return input;
  }
}

export async function buildSpotifyFallbackSearch(url) {
  // Versuche zuerst die offizielle oEmbed-API, um einen lesbaren Titel
  // für die YouTube-Suche zu erhalten.
  if (typeof fetch !== "function") return `ytsearch:${url}`;

  try {
    const res = await fetch(`${OEMBED_ENDPOINT}${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json();
      const title = data?.title?.trim();
      const artist = data?.author_name?.trim();

      if (title || artist) {
        const uniqueParts = Array.from(
          new Set([
            title && `"${title}"`,
            artist && `"${artist}"`,
          ].filter(Boolean)),
        );

        // Quotes sorgen dafür, dass der Songtitel/Artist genau gematcht werden
        // und nicht mit ähnlich benannten Uploads verwechselt werden.
        const query = `${uniqueParts.join(" ")} official audio`.trim();
        if (query) return `ytsearch:${query}`;
      }
    }
  } catch {
    // Netzwerkfehler -> Fallback weiter unten benutzen
  }

  // Minimaler Fallback: nutze die URL selbst als Suchbegriff, damit die
  // Nutzer dennoch einen Treffer bekommen können.
  return `ytsearch:${url}`;
}
