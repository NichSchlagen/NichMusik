// src/sources/spotify.js
// Spotify-Helper mit Fallback auf YouTube-Suche, falls der Lavalink-Node
// keine Spotify-Integration besitzt.

const OEMBED_ENDPOINT = "https://open.spotify.com/oembed?url=";

// Best effort Cleanup für die Suche, damit YouTube die richtigen Uploads findet.
function cleanupTrackTitle(title) {
  if (!title) return title;

  // Entferne übliche Suffixe wie "- Remastered 2011" oder "(Single Version)"
  const withoutRemaster = title
    .replace(/\s*-\s*remaster(ed)?\s*\d{0,4}\s*$/i, "")
    .replace(/\s*-\s*single version\s*$/i, "")
    .replace(/\s*\(.*?version.*?\)\s*$/i, "")
    .replace(/\s*\(.*?remaster.*?\)\s*$/i, "")
    .trim();

  return withoutRemaster || title.trim();
}

function splitArtists(artist) {
  if (!artist) return [];

  return artist
    .split(/,|&| feat\.? | featuring | mit /i)
    .map((part) => part.trim())
    .filter(Boolean);
}

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
      const title = cleanupTrackTitle(data?.title?.trim());
      const primaryArtist = splitArtists(data?.author_name?.trim())?.[0];

      if (title || primaryArtist) {
        const uniqueParts = Array.from(
          new Set([
            title && `"${title}"`,
            primaryArtist && `"${primaryArtist}"`,
          ].filter(Boolean)),
        );

        // Quotes sorgen dafür, dass Songtitel/Artists genau gematcht werden und
        // nicht mit ähnlich benannten Uploads verwechselt werden.
        const baseQuery = uniqueParts.join(" ").trim();
        if (baseQuery) {
          // Zwei Varianten probieren: offizielle Audio-Uploads oder Lyrics,
          // damit auch Nicht-Topic-Uploads gefunden werden.
          const queryVariants = [
            `${baseQuery} official audio`.trim(),
            `${baseQuery} lyrics`.trim(),
          ].filter(Boolean);

          if (queryVariants.length > 0) {
            return `ytsearch:${queryVariants.join(" | ")}`;
          }
        }
      }
    }
  } catch {
    // Netzwerkfehler -> Fallback weiter unten benutzen
  }

  // Minimaler Fallback: nutze die URL selbst als Suchbegriff, damit die
  // Nutzer dennoch einen Treffer bekommen können.
  return `ytsearch:${url}`;
}
