// src/services/musicService.js
// Enthält die Kernlogik für Queueing, Playback und Voice-Management rund um Lavalink.
import {
  mustGetNode,
  getExistingPlayer,
  joinOrGetPlayer,
  extractTracksFromResolve,
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

// Zustand je Guild in Maps halten, damit der Service instanzlos genutzt werden kann.
const queues = new Map(); // guildId -> { items: Array<{ encoded, info }>, playing: boolean, announceChannelId?: string | null }
const nowPlaying = new Map(); // guildId -> string title
const idleTimers = new Map(); // guildId -> Timeout

function buildFailure(reason, err, extra = {}) {
  return { ok: false, reason, error: errToObj(err), ...extra };
}

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (q) return q;

  const created = { items: [], playing: false, announceChannelId: null };
  queues.set(guildId, created);
  return created;
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

async function announceNowPlaying(client, channelId, description, guildId) {
  if (!client || !channelId) return;

  try {
    const channel = client.channels?.cache?.get(channelId) || (await client.channels?.fetch?.(channelId));
    if (!channel?.send) return;

    await channel.send({
      embeds: [buildNowPlayingEmbed(description)],
      components: buildNowPlayingControls(guildId),
    });
  } catch (e) {
    log("warn", "[Music] Failed to announce now playing", { channelId, err: errToObj(e) });
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
        const player = getExistingPlayer(shoukaku, guildId);
        if (!player) return;

        const q = getQueue(guildId);

        // Nur leaven, wenn wirklich idle:
        // - Queue leer
        // - und aktuell kein Track
        if (q.items.length === 0 && !player.track) {
          // Queue/NowPlaying aufräumen
          nowPlaying.delete(guildId);
          q.items = [];

          log("info", "[Music] Leaving idle voice channel", { guildId });

          if (typeof player.disconnect === "function") {
            await player.disconnect();
          } else if (typeof shoukaku.leaveVoiceChannel === "function") {
            await shoukaku.leaveVoiceChannel(guildId);
          }
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
  nowPlaying.delete(guildId);
  return q;
}

function handleQueueFinished(shoukaku, guildId) {
  nowPlaying.delete(guildId);

  const q = getQueue(guildId);
  q.announceChannelId = null;

  log("info", "[Music] Queue finished", { guildId });
  scheduleAutoLeave(shoukaku, guildId);
}

async function playNext(shoukaku, client, guildId) {
  const q = getQueue(guildId);
  if (q.playing) return;
  q.playing = true;

  try {
    while (true) {
      const player = getExistingPlayer(shoukaku, guildId);
      if (!player) {
        nowPlaying.delete(guildId);
        if (q.items.length === 0) {
          handleQueueFinished(shoukaku, guildId);
        }
        log("warn", "[Music] Missing player while advancing queue", { guildId, queueLength: q.items.length });
        return;
      }

      const next = q.items.shift();
      if (!next) {
        // nichts mehr zu spielen -> Auto-Leave starten
        handleQueueFinished(shoukaku, guildId);
        return;
      }

      // sobald wir spielen wollen: Auto-Leave stoppen
      clearIdleTimer(guildId);

      const description = describeTrack(next.info);
      nowPlaying.set(guildId, description);
      log("info", "[Music] Now playing", { guildId, track: description });
      if (q.announceChannelId) {
        await announceNowPlaying(client, q.announceChannelId, description, guildId);
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

      const player = joinResult.player;
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

      const track = tracks[0];
      const encoded = extractEncoded(track);
      const info = extractInfo(track);
      const display = describeTrack(info);
      if (!encoded) return { ok: false, reason: "NO_ENCODED", info };

      const q = getQueue(guildId);
      if (textChannelId) q.announceChannelId = textChannelId;

      const busy = Boolean(player.track) || q.items.length > 0;
      q.items.push({ encoded, info });

      if (busy) {
        return {
          ok: true,
          queued: true,
          title: info?.title || "Unbekannt",
          display,
          info,
          queuePosition: q.items.length,
        };
      }

      try {
        await playNext(shoukaku, client, guildId);
        return { ok: true, queued: false, title: info?.title || "Unbekannt", display, info };
      } catch (e) {
        log("error", "[Music] Failed to start playback", { guildId, query, err: errToObj(e) });
        return buildFailure("PLAY_FAILED", e, { query });
      }
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

      // Cache for subsequent calls to keep behavior consistent.
      nowPlaying.set(guildId, label);
      return { ok: true, track: label };
    },

    // -------- /queue support --------
    /** Liefert eine Instant-Ansicht der Queue inkl. "Now Playing". */
    getQueueSnapshot({ guildId }) {
      const q = getQueue(guildId);
      return {
        nowPlaying: nowPlaying.get(guildId) || null,
        items: q.items.map((x) => describeTrack(x.info)),
      };
    },
  };
}
