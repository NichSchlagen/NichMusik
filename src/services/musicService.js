// src/services/musicService.js
// Enthält die Kernlogik für Queueing, Playback und Voice-Management rund um Lavalink.
import {
  mustGetNode,
  getExistingPlayer,
  joinOrGetPlayer,
  extractEncoded,
  extractInfo,
  playEncoded,
  stopPlayer,
  setPaused,
} from "../infra/lavalink/compat.js";
import { AUTO_LEAVE_MS } from "../config/index.js";
import { resolveMusicQuery } from "../sources/resolver.js";
import { log, errToObj } from "../utils/logger.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { CONTROL_ACTIONS } from "../app/constants.js";
import { buildNowPlayingEmbed } from "../app/embeds.js";
import { randomUUID } from "crypto";

// Zustand je Guild in Maps halten, damit der Service instanzlos genutzt werden kann.
// guildId -> {
//   items: Array<{ encoded, info }>;
//   playing: boolean;
//   announceChannelId?: string | null;
//   lastAnnounceMessage?: { channelId: string, messageId: string } | null;
// }
const queues = new Map();
const nowPlaying = new Map(); // guildId -> { label: string, artworkUrl?: string }
const idleTimers = new Map(); // guildId -> Timeout
const pendingSelections = new Map(); // token -> { guildId, channelId, shardId, deaf, textChannelId, suggestions }
const pendingSelectionTimers = new Map(); // token -> Timeout
const SELECTION_TTL_MS = 60_000;

function buildFailure(reason, err, extra = {}) {
  return { ok: false, reason, error: errToObj(err), ...extra };
}

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (q) return q;

  const created = { items: [], playing: false, announceChannelId: null, lastAnnounceMessage: null };
  queues.set(guildId, created);
  return created;
}

async function deleteLastAnnouncement(client, queue) {
  const last = queue?.lastAnnounceMessage;
  if (!client || !last?.channelId || !last?.messageId) return;

  try {
    const channel = client.channels?.cache?.get(last.channelId) || (await client.channels?.fetch?.(last.channelId));
    if (!channel?.messages?.fetch) return;

    const message = await channel.messages.fetch(last.messageId).catch(() => null);
    if (!message) return;

    if (message.deletable) await message.delete().catch(() => {});
  } catch (e) {
    log("warn", "[Music] Failed to delete old announcement", { err: errToObj(e), channelId: last?.channelId });
  } finally {
    if (queue) queue.lastAnnounceMessage = null;
  }
}

function buildNowPlayingControls(guildId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`np:${guildId}:${CONTROL_ACTIONS.pause}`)
      .setLabel("Pause")
      .setEmoji("⏸️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`np:${guildId}:${CONTROL_ACTIONS.resume}`)
      .setLabel("Fortsetzen")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`np:${guildId}:${CONTROL_ACTIONS.skip}`)
      .setLabel("Skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`np:${guildId}:${CONTROL_ACTIONS.queue}`)
      .setLabel("Queue")
      .setEmoji("📜")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`np:${guildId}:${CONTROL_ACTIONS.stop}`)
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
  );

  return [row];
}

async function announceNowPlaying(client, queue, nowPlayingInfo, guildId) {
  if (!client || !queue?.announceChannelId) return;

  try {
    await deleteLastAnnouncement(client, queue);

    const channel =
      client.channels?.cache?.get(queue.announceChannelId) || (await client.channels?.fetch?.(queue.announceChannelId));
    if (!channel?.send) return;

    const message = await channel.send({
      embeds: [buildNowPlayingEmbed(nowPlayingInfo)],
      components: buildNowPlayingControls(guildId),
    });

    queue.lastAnnounceMessage = { channelId: channel.id, messageId: message.id };
  } catch (e) {
    log("warn", "[Music] Failed to announce now playing", {
      channelId: queue?.announceChannelId,
      err: errToObj(e),
    });
  }
}

function formatDuration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mmss = `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;

  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function describeTrack(info) {
  const title = info?.title?.trim() || "Unbekannt";
  const author = info?.author?.trim();
  const duration = formatDuration(info?.length ?? info?.duration ?? info?.lengthMs);
  const uri = info?.uri || info?.url || info?.sourceUri;

  const prettyTitle = uri ? `**[${title}](${uri})**` : `**${title}**`;

  const parts = [prettyTitle];
  if (author) parts.push(author);
  if (duration) parts.push(`(${duration})`);

  return parts.join(" — ");
}

function truncate(text, max = 100) {
  if (!text || typeof text !== "string") return text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clearSelectionTimer(token) {
  const t = pendingSelectionTimers.get(token);
  if (t) clearTimeout(t);
  pendingSelectionTimers.delete(token);
}

function scheduleSelectionExpiry(token) {
  clearSelectionTimer(token);
  pendingSelectionTimers.set(
    token,
    setTimeout(() => {
      pendingSelections.delete(token);
      pendingSelectionTimers.delete(token);
    }, SELECTION_TTL_MS)
  );
}

function findArtwork(info) {
  const artwork = info?.artworkUrl || info?.artwork_url || info?.thumbnail;
  if (typeof artwork === "string") return artwork;
  if (typeof artwork?.url === "string") return artwork.url;

  const source = info?.sourceName || info?.source || "";
  const id = info?.identifier;

  if (id && source.toLowerCase().includes("youtube")) {
    return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  }

  return null;
}

function clearIdleTimer(guildId) {
  const t = idleTimers.get(guildId);
  if (t) clearTimeout(t);
  idleTimers.delete(guildId);
}

function scheduleAutoLeave(shoukaku, guildId, ms = AUTO_LEAVE_MS || 120000) {
  clearIdleTimer(guildId);

  log("info", "[Music] Auto-leave scheduled", { guildId, afterMs: ms });

  idleTimers.set(
    guildId,
    setTimeout(async () => {
      try {
        const q = getQueue(guildId);

        // noch etwas aktiv oder queued -> nicht idle
        if (nowPlaying.has(guildId)) return;
        if (q.items.length > 0) return;

        const player = getExistingPlayer(shoukaku, guildId);

        // Player kann bereits weg sein -> trotzdem Voice verlassen
        if (!player) {
          await shoukaku.leaveVoiceChannel?.(guildId);
          return;
        }

        // Lavalink v4: player.track ist oft stale -> nicht benutzen
        const paused = player.paused === true;

        // falls keine Positionsdaten vorhanden sind
        if (typeof player.position !== "number") {
          if (!paused) {
            nowPlaying.delete(guildId);
            q.items = [];
            q.announceChannelId = null;
            q.lastAnnounceMessage = null;

            if (typeof player.disconnect === "function") await player.disconnect();
            else await shoukaku.leaveVoiceChannel?.(guildId);
          }
          return;
        }

        // bewegt sich die Position noch?
        const pos1 = player.position;
        await new Promise((r) => setTimeout(r, 1500));
        const pos2 = getExistingPlayer(shoukaku, guildId)?.position ?? pos1;

        if (!paused && pos2 <= pos1) {
          nowPlaying.delete(guildId);
          q.items = [];
          q.announceChannelId = null;
          q.lastAnnounceMessage = null;

          log("info", "[Music] Leaving idle voice channel", { guildId });
          if (typeof player.disconnect === "function") await player.disconnect();
          else await shoukaku.leaveVoiceChannel?.(guildId);
        }
      } finally {
        idleTimers.delete(guildId);
      }
    }, ms)
  );
}

function resetQueueState(guildId) {
  const q = getQueue(guildId);
  q.items = [];
  q.announceChannelId = null;
  q.lastAnnounceMessage = null;
  nowPlaying.delete(guildId);
  return q;
}

async function handleQueueFinished(shoukaku, client, guildId) {
  nowPlaying.delete(guildId);

  const q = getQueue(guildId);
  q.announceChannelId = null;
  await deleteLastAnnouncement(client, q);

  log("info", "[Music] Queue finished", { guildId });
  scheduleAutoLeave(shoukaku, guildId);
}

async function playNext(shoukaku, client, guildId) {
  const q = getQueue(guildId);
  if (q.playing) return;
  q.playing = true;

  try {
    if (q.items.length === 0 && !nowPlaying.has(guildId)) {
      await handleQueueFinished(shoukaku, client, guildId);
      return;
    }

    while (q.items.length > 0 || nowPlaying.has(guildId)) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) {
        nowPlaying.delete(guildId);
        if (q.items.length === 0) {
          await handleQueueFinished(shoukaku, client, guildId);
        }
        log("warn", "[Music] Missing player while advancing queue", { guildId, queueLength: q.items.length });
        return;
      }

      const next = q.items.shift();
      if (!next) {
        // nichts mehr zu spielen -> Auto-Leave starten
        await handleQueueFinished(shoukaku, client, guildId);
        return;
      }

      // sobald wir spielen wollen: Auto-Leave stoppen
      clearIdleTimer(guildId);

      const description = describeTrack(next.info);
      const artworkUrl = findArtwork(next.info);
      const trackMeta = { label: description, artworkUrl };

      nowPlaying.set(guildId, trackMeta);
      log("info", "[Music] Now playing", { guildId, track: description });
      if (q.announceChannelId) {
        await announceNowPlaying(client, q, trackMeta, guildId);
      }

      try {
        await playEncoded(player, next.encoded);
        return;
      } catch (e) {
        log("error", "[Music] Failed to start track, skipping", { guildId, track: description, err: errToObj(e) });
        nowPlaying.delete(guildId);

        // Queue ist damit konsistent, aber der Player steht noch -> erneut versuchen.
        if (q.items.length === 0) {
          q.announceChannelId = null;
          scheduleAutoLeave(shoukaku, guildId);
          return;
        }
      }
    }
  } finally {
    q.playing = false;
  }
}

function wirePlayerQueue(shoukaku, client, player, guildId) {
  if (!player || player.__queueWired) return;
  player.__queueWired = true;

  const onEndLike = async () => {
    try {
      await playNext(shoukaku, client, guildId);
    } catch {
      // still
    }
  };

  player.on?.("end", onEndLike);
  player.on?.("stuck", onEndLike);
  player.on?.("exception", onEndLike);
}

function looksLikeUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSearchLoadType(loadType) {
  const normalized = String(loadType || "").toLowerCase();
  return normalized === "search_result" || normalized === "search";
}

async function enqueueAndMaybePlay({
  guildId,
  track,
  textChannelId,
  shoukaku,
  client,
  query,
}) {
  const q = getQueue(guildId);
  if (textChannelId) q.announceChannelId = textChannelId;

  const busy = nowPlaying.has(guildId) || q.items.length > 0;
  q.items.push(track);

  const display = describeTrack(track.info);
  const title = track.info?.title || "Unbekannt";

  if (busy) {
    return {
      ok: true,
      queued: true,
      title,
      display,
      info: track.info,
      queuePosition: q.items.length,
    };
  }

  try {
    await playNext(shoukaku, client, guildId);
    return { ok: true, queued: false, title, display, info: track.info };
  } catch (e) {
    log("error", "[Music] Failed to start playback", { guildId, query, err: errToObj(e) });
    return buildFailure("PLAY_FAILED", e, { query });
  }
}

export function createMusicService(shoukaku, client) {
  // Der Music-Service kapselt die Shoukaku-Interaktionen und stellt
  // eine minimalistische API für die Slash-Commands bereit.
  return {
    /** Prüft, ob ein Lavalink-Node verfügbar ist. */
    ensureReady() {
      mustGetNode(shoukaku);
      return true;
    },

    /** Join- oder bestehender Player, inkl. Stoppen des Auto-Leaves. */
    async join({ guildId, channelId, shardId, deaf = true }) {
      try {
        mustGetNode(shoukaku);
        clearIdleTimer(guildId);

        const player = await joinOrGetPlayer(shoukaku, { guildId, channelId, shardId, deaf });
        wirePlayerQueue(shoukaku, client, player, guildId);

        return { ok: true, player };
      } catch (e) {
        log("error", "[Music] Voice join failed", { guildId, channelId, err: errToObj(e) });
        return buildFailure("JOIN_FAILED", e, { channelId });
      }
    },

    /**
     * Spielt einen Track oder queued ihn, falls bereits etwas läuft.
     * Normalize YouTube-URLs, damit Lavalink besser damit umgehen kann.
     */
    async play({ guildId, channelId, shardId, query, deaf = true, textChannelId = null }) {
      mustGetNode(shoukaku);
      clearIdleTimer(guildId);

      const joinResult = await this.join({ guildId, channelId, shardId, deaf });
      if (!joinResult.ok) return joinResult;

      const node = mustGetNode(shoukaku);

      let resolution;
      try {
        resolution = await resolveMusicQuery(node, query);
      } catch (e) {
        log("error", "[Music] Query resolution failed", { guildId, query, err: errToObj(e) });
        return buildFailure("RESOLVE_FAILED", e, { query });
      }

      const tracks = resolution?.tracks || [];
      if (!tracks.length)
        return {
          ok: false,
          reason: "NO_TRACKS",
          loadType: resolution?.loadType,
          source: resolution?.source,
          filteredPremium: resolution?.filteredPremium,
        };

      const isSearchResult = isSearchLoadType(resolution?.loadType);
      const allowSelection =
        isSearchResult &&
        tracks.length > 1 &&
        !looksLikeUrl(query) &&
        typeof randomUUID === "function";

      if (allowSelection) {
        const suggestions = tracks
          .slice(0, 5)
          .map((track) => {
            const encoded = extractEncoded(track);
            const info = extractInfo(track);
            if (!encoded) return null;
            return { encoded, info };
          })
          .filter(Boolean);

        if (suggestions.length > 1) {
          const token = randomUUID();
          pendingSelections.set(token, {
            guildId,
            channelId,
            shardId,
            deaf,
            textChannelId,
            suggestions,
          });
          scheduleSelectionExpiry(token);

          return {
            ok: true,
            needsSelection: true,
            token,
            ttlMs: SELECTION_TTL_MS,
            choices: suggestions.map((s, idx) => ({
              index: idx,
              label: truncate(s.info?.title || s.info?.identifier || `Treffer ${idx + 1}`),
              description: truncate(describeTrack(s.info)),
            })),
          };
        }
      }

      const track = tracks[0];
      const encoded = extractEncoded(track);
      const info = extractInfo(track);
      if (!encoded) return { ok: false, reason: "NO_ENCODED", info };

      return enqueueAndMaybePlay({
        guildId,
        track: { encoded, info },
        textChannelId,
        shoukaku,
        client,
        query,
      });
    },

    async completeSearchSelection({ guildId, token, choiceIndex }) {
      const pending = pendingSelections.get(token);
      if (!pending) return { ok: false, reason: "SELECTION_EXPIRED" };
      pendingSelections.delete(token);
      clearSelectionTimer(token);

      if (pending.guildId !== guildId) {
        return { ok: false, reason: "WRONG_GUILD" };
      }

      const selected = pending.suggestions?.[choiceIndex];
      if (!selected?.encoded) {
        return { ok: false, reason: "INVALID_SELECTION" };
      }

      const joinResult = await this.join({
        guildId,
        channelId: pending.channelId,
        shardId: pending.shardId,
        deaf: pending.deaf,
      });

      if (!joinResult.ok) return joinResult;

      return enqueueAndMaybePlay({
        guildId,
        track: selected,
        textChannelId: pending.textChannelId,
        shoukaku,
        client,
        query: "search-selection",
      });
    },

    /** Springt zum nächsten Track (falls vorhanden) und stoppt den aktuellen. */
    async skip({ guildId }) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) return { ok: false, reason: "NO_PLAYER" };

      const q = getQueue(guildId);
      const upcoming = q.items[0];
      const next = upcoming ? describeTrack(upcoming.info) : null;

      await stopPlayer(player);

      // stop feuert nicht immer end zuverlässig -> next aktiv triggern
      await playNext(shoukaku, client, guildId);

      return { ok: true, next };
    },

    /** Trennt den Bot aus dem Voice-Channel und räumt die Queue auf. */
    async leave({ guildId }) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) return { ok: false, reason: "NO_PLAYER" };

      clearIdleTimer(guildId);

      await deleteLastAnnouncement(client, getQueue(guildId));
      resetQueueState(guildId);

      if (typeof player.disconnect === "function") {
        await player.disconnect();
        return { ok: true };
      }

      if (typeof shoukaku.leaveVoiceChannel === "function") {
        await shoukaku.leaveVoiceChannel(guildId);
        return { ok: true };
      }

      return { ok: false, reason: "NO_DISCONNECT_METHOD" };
    },

    /** Pausiert den aktuellen Track. */
    async pause({ guildId }) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) return { ok: false, reason: "NO_PLAYER" };

      if (player.paused) return { ok: false, reason: "ALREADY_PAUSED" };

      await setPaused(player, true);
      return { ok: true };
    },

    /** Setzt die Wiedergabe fort. */
    async resume({ guildId }) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) return { ok: false, reason: "NO_PLAYER" };

      if (!player.paused) return { ok: false, reason: "NOT_PAUSED" };

      await setPaused(player, false);
      return { ok: true };
    },

    /** Stoppt die Wiedergabe und leert die Queue, bleibt aber im Voice. */
    async stop({ guildId }) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) return { ok: false, reason: "NO_PLAYER" };

      await deleteLastAnnouncement(client, getQueue(guildId));
      resetQueueState(guildId);

      await stopPlayer(player);
      scheduleAutoLeave(shoukaku, guildId);
      return { ok: true };
    },

    /** Liefert den aktuell laufenden Track. */
    getNowPlaying({ guildId }) {
      const cached = nowPlaying.get(guildId);
      if (cached) return { ok: true, track: cached };

      const player = getExistingPlayer(shoukaku, guildId);
      const current = player?.track;
      if (!current) return { ok: false, track: null };

      const info = extractInfo(current);
      const label = describeTrack(info);
      const artworkUrl = findArtwork(info);
      const trackMeta = { label, artworkUrl };

      // Cache for subsequent calls to keep behavior consistent.
      nowPlaying.set(guildId, trackMeta);
      return { ok: true, track: trackMeta };
    },

    // -------- /queue support --------
    /** Liefert eine Instant-Ansicht der Queue inkl. "Now Playing". */
    getQueueSnapshot({ guildId }) {
      const q = getQueue(guildId);
      return {
        nowPlaying: nowPlaying.get(guildId)?.label || null,
        items: q.items.map((x) => describeTrack(x.info)),
      };
    },
  };
}
