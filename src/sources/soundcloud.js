// src/sources/soundcloud.js
// Hilfsfunktionen rund um SoundCloud-Queries.

const SOUND_CLOUD_HOSTS = ["soundcloud.com", "www.soundcloud.com", "on.soundcloud.com"];
const SEARCH_PREFIX = "scsearch:";

function isSoundCloudHost(hostname) {
  const lower = hostname.toLowerCase();
  return SOUND_CLOUD_HOSTS.some((h) => lower === h || lower.endsWith(`.${h}`));
}

export function isSoundCloudQuery(input) {
  if (!input || typeof input !== "string") return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith(SEARCH_PREFIX)) return true;
  if (trimmed.toLowerCase().startsWith("soundcloud:")) return true;

  try {
    const url = new URL(trimmed);
    return isSoundCloudHost(url.hostname);
  } catch {
    return false;
  }
}

export function buildSoundCloudQuery(input) {
  if (!input || typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith(SEARCH_PREFIX)) return trimmed;
  if (trimmed.toLowerCase().startsWith("soundcloud:")) return `${SEARCH_PREFIX}${trimmed.slice("soundcloud:".length)}`;

  try {
    const url = new URL(trimmed);
    if (isSoundCloudHost(url.hostname)) return trimmed;
  } catch {
    // kein URL, fällt auf Suche zurück
  }

  return `${SEARCH_PREFIX}${trimmed}`;
}

