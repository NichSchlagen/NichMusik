// src/sources/resolver.js
// Zentrale Stelle, um Nutzereingaben in Lavalink-Queries zu verwandeln und
// Quellen-spezifische Logik (YouTube-Suche, SoundCloud-Premium, Spotify-Fallback)
// zu bündeln.

import { extractTracksFromResolve } from "../infra/lavalink/compat.js";
import { buildYouTubeQuery } from "./youtube.js";
import { buildSoundCloudQuery, isSoundCloudQuery } from "./soundcloud.js";
import {
  buildSpotifyFallbackSearch,
  isSpotifyUrl,
  normalizeSpotifyUrl,
} from "./spotify.js";

function looksLikeUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function resolveWithContext(node, query, source) {
  try {
    return await node.rest.resolve(query);
  } catch (e) {
    const err = new Error(`Resolve für ${source} fehlgeschlagen: ${query}`);
    err.query = query;
    err.source = source;
    err.cause = e;
    throw err;
  }
}

export async function resolveMusicQuery(node, rawQuery) {
  const query = rawQuery?.trim();
  if (!query) return { loadType: "NO_QUERY", tracks: [], source: "unknown" };

  // 1) Spotify mit Fallback auf YouTube-Suche
  if (isSpotifyUrl(query)) {
    const spotifyUrl = normalizeSpotifyUrl(query);

    const fallbackQuery = await buildSpotifyFallbackSearch(spotifyUrl);
    const fallback = await resolveWithContext(node, fallbackQuery, "spotify-fallback");
    const fallbackTracks = extractTracksFromResolve(fallback);
    return {
      loadType: fallback?.loadType,
      tracks: fallbackTracks,
      source: "spotify-fallback",
      usedQuery: fallbackQuery,
    };
  }

  // 2) SoundCloud ohne Premium-Filter (alles wird versucht abzuspielen)
  if (isSoundCloudQuery(query)) {
    const scQuery = buildSoundCloudQuery(query);
    const res = await resolveWithContext(node, scQuery, "soundcloud");
    const tracks = extractTracksFromResolve(res);

    return {
      loadType: res?.loadType,
      tracks,
      source: "soundcloud",
      playlistInfo: res?.playlistInfo || res?.data?.info || null,
    };
  }

  // 3) Default: YouTube (inkl. String-Suche)
  const ytQuery = buildYouTubeQuery(query);
  const res = await resolveWithContext(node, ytQuery, "youtube");
  const tracks = extractTracksFromResolve(res);

  return {
    loadType: res?.loadType,
    tracks,
    source: "youtube",
    usedQuery: ytQuery,
    playlistInfo: res?.playlistInfo || res?.data?.info || null,
  };
}

export async function resolvePlaylistQuery(node, rawQuery) {
  const query = rawQuery?.trim();
  if (!query) return { loadType: "NO_QUERY", tracks: [], source: "unknown" };

  // Playlist-Command erwartet eine URL
  if (!looksLikeUrl(query)) {
    return { loadType: "NO_QUERY", tracks: [], source: "unknown" };
  }

  if (isSpotifyUrl(query)) {
    return { loadType: "NO_PLAYLIST", tracks: [], source: "spotify" };
  }

  if (isSoundCloudQuery(query)) {
    const res = await resolveWithContext(node, query, "soundcloud");
    const tracks = extractTracksFromResolve(res);
    return {
      loadType: res?.loadType,
      tracks,
      source: "soundcloud",
      playlistInfo: res?.playlistInfo || res?.data?.info || null,
    };
  }

  const res = await resolveWithContext(node, query, "playlist-url");
  const tracks = extractTracksFromResolve(res);
  return {
    loadType: res?.loadType,
    tracks,
    source: "playlist-url",
    playlistInfo: res?.playlistInfo || res?.data?.info || null,
  };
}
