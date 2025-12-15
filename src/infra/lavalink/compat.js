// src/infra/lavalink/compat.js
// Sammlung von Hilfsfunktionen, die unterschiedliche Shoukaku-/Lavalink-Versionen
// abstrahieren und so eine stabile API für den Rest des Codes bieten.

// ---- Node / Player Helpers (versions-safe) ----
/** Liefert true, wenn der Node laut State als connected gilt. */
export function isNodeConnected(node) {
  return !!node && (node.state === 2 || node.state === "CONNECTED");
}

export function pickNode(shoukaku) {
  if (!shoukaku) return null;

  if (typeof shoukaku.getIdealNode === "function") {
    const n = shoukaku.getIdealNode();
    if (n) return n;
  }

  if (typeof shoukaku.getNode === "function") {
    const n = shoukaku.getNode();
    if (n) return n;
  }

  const nodes = shoukaku.nodes;

  if (nodes instanceof Map) {
    for (const [, n] of nodes) if (isNodeConnected(n)) return n;
    for (const [, n] of nodes) return n;
  } else if (nodes && typeof nodes === "object") {
    const arr = Object.values(nodes);
    return arr.find(isNodeConnected) || arr[0];
  }

  return null;
}

export function mustGetNode(shoukaku) {
  const node = pickNode(shoukaku);
  if (!node) throw new Error("No Lavalink nodes available (not ready/connected).");
  return node;
}

// Versuche bestehende Player/Connections zu finden
export function getExistingPlayer(shoukaku, guildId) {
  const node = pickNode(shoukaku);
  const p1 = node?.players?.get?.(guildId);
  if (p1) return p1;

  const p2 = shoukaku.players?.get?.(guildId);
  if (p2) return p2;

  const c = shoukaku.connections?.get?.(guildId);
  if (c) return c;

  return null;
}

// Join nur wenn nötig (idempotent)
export async function joinOrGetPlayer(shoukaku, { guildId, channelId, shardId, deaf = true }) {
  const existing = getExistingPlayer(shoukaku, guildId);
  if (existing) return existing;

  if (typeof shoukaku.joinVoiceChannel === "function") {
    try {
      return await shoukaku.joinVoiceChannel({ guildId, channelId, shardId, deaf });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("already have an existing connection")) {
        const again = getExistingPlayer(shoukaku, guildId);
        if (again) return again;
      }
      throw e;
    }
  }

  const node = mustGetNode(shoukaku);
  if (typeof node.joinChannel === "function") {
    return await node.joinChannel({ guildId, channelId, shardId, deaf });
  }

  throw new Error("Shoukaku API mismatch: no joinVoiceChannel/joinChannel available.");
}

// Lavalink v4 safe: encoded & info aus verschiedenen Shapes ziehen
export function extractEncoded(track) {
  return track?.encoded || track?.track || track?.data?.encoded || null;
}

export function extractInfo(track) {
  return track?.info || track?.data?.info || track?.data || track || {};
}

// Lavalink v4 safe: resolve result
export function extractTracksFromResolve(res) {
  // v4: { loadType, data: Track | Track[] }
  if (Array.isArray(res?.data)) return res.data;
  if (res?.data) return [res.data];

  // fallback (v3-style)
  if (Array.isArray(res?.tracks)) return res.tracks;

  return [];
}

// Lavalink v4 safe: play
export async function playEncoded(player, encoded) {
  // v4 expects: { track: { encoded: "..." } }
  if (typeof player.update === "function") {
    return await player.update({ track: { encoded } });
  }

  // fallback: try both shapes
  if (typeof player.playTrack === "function") {
    try {
      return await player.playTrack({ track: { encoded } });
    } catch {
      return await player.playTrack({ track: encoded });
    }
  }

  throw new Error("Player has neither update() nor playTrack().");
}

// v4-safe stop
export async function stopPlayer(player) {
  if (typeof player.stopTrack === "function") return await player.stopTrack();
  if (typeof player.update === "function") return await player.update({ track: null });
  throw new Error("Player has neither stopTrack() nor update().");
}

// v4-safe pause/resume
export async function setPaused(player, paused) {
  if (typeof player.setPaused === "function") return await player.setPaused(paused);
  if (typeof player.pause === "function") return await player.pause(paused);
  if (typeof player.update === "function") return await player.update({ paused });
  throw new Error("Player has no pause control.");
}
