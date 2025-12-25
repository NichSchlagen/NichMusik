// src/app/interactionHandler.js
// Zentrales Routing der Slash-Commands und Schutz vor typischen Voice-Fehlern.
import { ActionRowBuilder, Events, PermissionsBitField, StringSelectMenuBuilder } from "discord.js";
import { EPHEMERAL } from "../config/index.js";
import { log, errToObj } from "../utils/logger.js";
import { CONTROL_ACTIONS } from "./constants.js";
import {
  buildActionEmbed,
  buildQueuedEmbed,
  buildNowPlayingEmbed,
  buildQueueEmbed,
} from "./embeds.js";

function isVoiceJoinTimeout(e) {
  const msg = String(e?.message || "").toLowerCase();
  return msg.includes("voice connection is not established");
}

function describeUserFacingFailure(res, kind = "generic") {
  if (!res) return "Unbekannter Fehler (keine Details verfügbar).";

  const detail = res.error?.message || res.error?.code || res.reason;

  if (res.reason === "JOIN_FAILED") {
    return `🚫 Konnte dem Voice-Channel nicht beitreten: ${detail || "unbekannter Grund"}.`;
  }

  if (res.reason === "RESOLVE_FAILED") {
    return "🚫 Lavalink konnte die Anfrage nicht auflösen. Bitte später erneut versuchen.";
  }

  if (res.reason === "PLAY_FAILED") {
    return `🚫 Wiedergabe konnte nicht gestartet werden${detail ? ` (${detail})` : "."}`;
  }

  if (res.reason === "NO_TRACKS") return "Nichts gefunden. 😵‍💫";
  if (res.reason === "NO_ENCODED") return "Track geladen, aber Encoding fehlt (API mismatch).";
  if (res.reason === "NOT_PLAYLIST") return "Das ist keine Playlist. Bitte eine Playlist-URL verwenden.";
  if (res.reason === "INVALID_VOLUME") return "Ungültige Lautstärke.";
  if (res.reason === "OUT_OF_RANGE") return "Lautstärke muss zwischen 0 und 100 liegen.";

  if (kind === "join") {
    return `🚫 Konnte dem Voice-Channel nicht beitreten${detail ? ` (${detail})` : "."}`;
  }

  if (kind === "play") {
    return `🚫 Song konnte nicht gestartet werden${detail ? ` (${detail})` : "."}`;
  }

  if (kind === "volume") {
    return `🚫 Lautstärke konnte nicht gesetzt werden${detail ? ` (${detail})` : "."}`;
  }

  return `💥 Unerwarteter Fehler${detail ? ` (${detail})` : "."}`;
}

function canJoinVoice(interaction, vc) {
  // Channel voll?
  if (vc?.userLimit > 0 && vc.members?.size >= vc.userLimit) {
    return { ok: false, message: "🚫 Der Voice-Channel ist voll." };
  }

  // Permissions prüfen (CONNECT / SPEAK)
  const me = interaction.guild?.members?.me;
  if (!me) return { ok: true };

  const perms = vc.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.Connect)) {
    return { ok: false, message: "🚫 Ich darf dem Voice-Channel nicht beitreten (CONNECT fehlt)." };
  }
  if (!perms?.has(PermissionsBitField.Flags.Speak)) {
    return { ok: false, message: "🚫 Ich darf dort nicht sprechen (SPEAK fehlt)." };
  }

  return { ok: true };
}

function replyEphemeral(interaction, content) {
  return interaction.reply({ content, flags: EPHEMERAL });
}

// Merkt sich den letzten öffentlich gesendeten Status-Post je Guild ("Track hinzugefügt", "Voice beigetreten"),
// damit beim nächsten Status der alte gelöscht wird und der Channel sauber bleibt.
const lastStatusMessages = new Map();
const lastStatusTimers = new Map();
const LEAVE_STATUS_TTL_MS = 30_000;

function clearStatusTimer(guildId) {
  const timer = lastStatusTimers.get(guildId);
  if (timer) clearTimeout(timer);
  lastStatusTimers.delete(guildId);
}

async function deleteLastStatusMessage(client, guildId, musicService) {
  const last = lastStatusMessages.get(guildId);
  clearStatusTimer(guildId);
  if (!client || !last?.channelId || !last?.messageId) return;

  try {
    const channel =
      client.channels?.cache?.get(last.channelId) || (await client.channels?.fetch?.(last.channelId));
    if (!channel?.messages?.fetch) return;

    const msg = await channel.messages.fetch(last.messageId).catch(() => null);
    if (!msg) return;

    if (msg.deletable) await msg.delete().catch(() => {});
  } catch (e) {
    log("warn", "[Slash] Failed to delete last status message", { guildId, err: errToObj(e) });
  } finally {
    lastStatusMessages.delete(guildId);
    musicService?.untrackStatusMessage?.({
      guildId,
      channelId: last?.channelId,
      messageId: last?.messageId,
    });
  }
}

function rememberStatusMessage(guildId, message, client, ttlMs, musicService) {
  if (!guildId || !message?.id || !message?.channelId) return;
  clearStatusTimer(guildId);
  lastStatusMessages.set(guildId, { channelId: message.channelId, messageId: message.id });
  musicService?.trackStatusMessage?.({ guildId, message });

  if (ttlMs && client) {
    const timer = setTimeout(() => deleteLastStatusMessage(client, guildId, musicService), ttlMs);
    lastStatusTimers.set(guildId, timer);
  }
}

function ensureCommandOnGuild(interaction) {
  if (interaction.guildId) return false;
  replyEphemeral(interaction, "Nur auf Servern nutzbar.");
  return true;
}

function ensureVoiceChannel(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (vc) return vc;
  replyEphemeral(interaction, "Geh erst in einen Voice-Channel.");
  return null;
}

function getBotVoiceChannelId(interaction) {
  return interaction.guild?.members?.me?.voice?.channelId || null;
}

function ensureSameVoiceChannel(interaction) {
  const botChannelId = getBotVoiceChannelId(interaction);
  if (!botChannelId) return true;

  const userChannelId = interaction.member?.voice?.channelId || null;
  if (userChannelId && userChannelId === botChannelId) return true;

  replyEphemeral(interaction, "Du musst im selben Voice-Channel sein wie der Bot.");
  return false;
}

let cachedMusicService = null;

function getQueueSnapshotSafe(musicService, guildId) {
  const service =
    musicService && typeof musicService.getQueueSnapshot === "function"
      ? musicService
      : cachedMusicService;

  if (!service || typeof service.getQueueSnapshot !== "function") {
    log("error", "[Slash] queue snapshot unavailable", {
      guildId,
      hasService: Boolean(service),
      serviceKeys: service ? Object.keys(service) : [],
    });
    return { nowPlaying: null, items: [] };
  }

  try {
    const snapshot = service.getQueueSnapshot({ guildId });
    if (!snapshot || typeof snapshot !== "object") {
      log("error", "[Slash] queue snapshot malformed", { guildId, snapshot: snapshot ?? null });
      return { nowPlaying: null, items: [] };
    }
    return snapshot;
  } catch (e) {
    log("error", "[Slash] queue snapshot failed", { guildId, err: errToObj(e) });
    return { nowPlaying: null, items: [] };
  }
}

function getNowPlayingSafe(musicService, guildId) {
  const service =
    musicService && typeof musicService.getNowPlaying === "function"
      ? musicService
      : cachedMusicService;

  if (!service || typeof service.getNowPlaying !== "function") {
    log("error", "[Slash] nowplaying unavailable", {
      guildId,
      hasService: Boolean(service),
      serviceKeys: service ? Object.keys(service) : [],
    });
    return { ok: false, track: null, reason: "NO_NOW_PLAYING_METHOD" };
  }

  try {
    const res = service.getNowPlaying({ guildId });
    if (!res || typeof res !== "object") {
      log("error", "[Slash] nowplaying malformed", { guildId, res: res ?? null });
      return { ok: false, track: null, reason: "NOW_PLAYING_MALFORMED" };
    }
    return res;
  } catch (e) {
    log("error", "[Slash] nowplaying failed", { guildId, err: errToObj(e) });
    return { ok: false, track: null, reason: "NOW_PLAYING_ERROR" };
  }
}

async function handleJoin(interaction, ctx, musicService) {
  const vc = ensureVoiceChannel(interaction);
  if (!vc) return;
  if (!ensureSameVoiceChannel(interaction)) return;

  const check = canJoinVoice(interaction, vc);
  if (!check.ok) return replyEphemeral(interaction, check.message);

  log("info", "[Slash] join", { ...ctx, channel: vc.id });

  const joinResult = await musicService.join({
    guildId: interaction.guildId,
    channelId: vc.id,
    shardId: interaction.guild?.shardId ?? 0,
    deaf: true,
  });

  if (!joinResult.ok) {
    return replyEphemeral(interaction, describeUserFacingFailure(joinResult, "join"));
  }

  await deleteLastStatusMessage(interaction.client, interaction.guildId, musicService);

  await interaction.reply({
    embeds: [
      buildActionEmbed({
        title: "Voice beigetreten",
        emoji: "✅",
        description: `Bin dem Voice-Channel **${vc.name}** beigetreten. Sag mir, was ich spielen soll!`,
      }),
    ],
  });

  const message = await interaction.fetchReply().catch(() => null);
  rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);

  return message;
}

async function handlePlay(interaction, ctx, musicService) {
  const query = interaction.options.getString("query", true);
  const vc = ensureVoiceChannel(interaction);
  if (!vc) return;
  if (!ensureSameVoiceChannel(interaction)) return;

  const check = canJoinVoice(interaction, vc);
  if (!check.ok) return replyEphemeral(interaction, check.message);

  log("info", "[Slash] play", { ...ctx, channel: vc.id, query });
  await interaction.deferReply();

  const result = await musicService.play({
    guildId: interaction.guildId,
    channelId: vc.id,
    shardId: interaction.guild?.shardId ?? 0,
    query,
    deaf: true,
    textChannelId: interaction.channelId,
  });

  if (!result.ok) {
    const friendly = describeUserFacingFailure(result, "play");
    return interaction.editReply({
      embeds: [
        buildActionEmbed({
          title: "Konnte nicht abspielen",
          emoji: "🚫",
          description: friendly,
        }),
      ],
    });
  }

  if (result.needsSelection && result.token && Array.isArray(result.choices)) {
    const options = result.choices.map((choice) => ({
      label: choice?.label?.slice(0, 100) || `Treffer ${choice.index + 1}`,
      description: choice?.description?.slice(0, 100) || undefined,
      value: choice.index?.toString?.() ?? String(choice?.index ?? 0),
    }));

    if (options.length === 0) {
      return interaction.editReply({
        embeds: [
          buildActionEmbed({
            title: "Konnte keine Auswahl bauen",
            emoji: "🚫",
            description: "Bitte versuch es nochmal.",
          }),
        ],
      });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`pick:${result.token}:${interaction.user?.id ?? ""}`)
      .setPlaceholder("Suchergebnis auswählen")
      .addOptions(options);

    const message = await interaction.editReply({
      embeds: [
        buildActionEmbed({
          title: "Mehrere Treffer gefunden",
          emoji: "🔍",
          description: "Bitte wähle das passende Ergebnis aus der Liste aus.",
        }),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    });

    const ttlMs = Number.isFinite(result.ttlMs) ? result.ttlMs : 60_000;
    const disabledSelect = StringSelectMenuBuilder.from(select).setDisabled(true);
    const disabledRow = new ActionRowBuilder().addComponents(disabledSelect);
    setTimeout(() => {
      message?.edit?.({ components: [disabledRow] }).catch(() => {});
    }, ttlMs);

    rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
    return message;
  }

  if (result.playlist) return replyWithPlaylist(interaction, result, musicService);

  const label = result.display || `**${result.title || "Unbekannt"}**`;

  await deleteLastStatusMessage(interaction.client, interaction.guildId, musicService);

  if (!result.queued) {
    return interaction.deleteReply().catch(() => {});
  }

  const message = await interaction.editReply({ embeds: [buildQueuedEmbed(label, result.queuePosition)] });
  rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
  return message;
}

async function handlePlaylist(interaction, ctx, musicService) {
  const query = interaction.options.getString("query", true);
  const vc = ensureVoiceChannel(interaction);
  if (!vc) return;
  if (!ensureSameVoiceChannel(interaction)) return;

  const check = canJoinVoice(interaction, vc);
  if (!check.ok) return replyEphemeral(interaction, check.message);

  log("info", "[Slash] playlist", { ...ctx, channel: vc.id, query });
  await interaction.deferReply();

  const result = await musicService.playPlaylist({
    guildId: interaction.guildId,
    channelId: vc.id,
    shardId: interaction.guild?.shardId ?? 0,
    query,
    deaf: true,
    textChannelId: interaction.channelId,
  });

  if (!result.ok) {
    const friendly = describeUserFacingFailure(result, "play");
    return interaction.editReply({
      embeds: [
        buildActionEmbed({
          title: "Konnte Playlist nicht laden",
          emoji: "🚫",
          description: friendly,
        }),
      ],
    });
  }

  if (result.playlist) return replyWithPlaylist(interaction, result, musicService);

  return interaction.editReply({
    embeds: [
      buildActionEmbed({
        title: "Konnte Playlist nicht laden",
        emoji: "🚫",
        description: "Das ist keine Playlist oder konnte nicht erkannt werden.",
      }),
    ],
  });
}

async function handleSkip(interaction, ctx, musicService) {
  log("info", "[Slash] skip", ctx);
  if (!ensureSameVoiceChannel(interaction)) return;

  const res = await musicService.skip({ guildId: interaction.guildId });
  if (!res.ok) return replyEphemeral(interaction, "Kein Player aktiv.");

  const description = res.next
    ? `Als nächstes: ${res.next}`
    : "Keine weiteren Tracks in der Queue.";

  return interaction.reply({
    embeds: [buildActionEmbed({ title: "Übersprungen", emoji: "⏭️", description })],
  });
}

async function handleLeave(interaction, ctx, musicService) {
  log("info", "[Slash] leave", ctx);

  await deleteLastStatusMessage(interaction.client, interaction.guildId, musicService);
  await musicService.clearSessionMessages({ guildId: interaction.guildId });

  const res = await musicService.leave({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Ich bin nicht im Voice.");
  }
  if (!res.ok && res.reason === "NO_DISCONNECT_METHOD") {
    throw new Error("No disconnect method found (player.disconnect / shoukaku.leaveVoiceChannel).");
  }

  const message = await interaction
    .reply({
      embeds: [
        buildActionEmbed({
          title: "Voice verlassen",
          emoji: "🛑",
          description: "Playback gestoppt, Queue geleert und Voice verlassen. Bis bald!",
        }),
      ],
    })
    .then(() => interaction.fetchReply().catch(() => null));

  rememberStatusMessage(interaction.guildId, message, interaction.client, LEAVE_STATUS_TTL_MS, musicService);
  return message;
}

function handleQueue(interaction, _ctx, musicService) {
  if (!ensureSameVoiceChannel(interaction)) return;
  const snap = getQueueSnapshotSafe(musicService, interaction.guildId);

  if (!snap.nowPlaying && snap.items.length === 0) {
    return interaction.reply({
      embeds: [buildQueueEmbed(snap)],
      flags: EPHEMERAL,
    });
  }

  return interaction
    .reply({ embeds: [buildQueueEmbed(snap)] })
    .then(() => interaction.fetchReply().catch(() => null))
    .then((message) => {
      rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
      return message;
    });
}

async function replyWithPlaylist(interaction, result, musicService) {
  const title = result.playlistName || "Playlist";
  const lines = [
    `**${title}**`,
    `Tracks: **${result.trackCount}**`,
  ];
  if (
    Number.isFinite(result.playlistTotal) &&
    Number.isFinite(result.playlistLimit) &&
    result.playlistTotal > result.playlistLimit
  ) {
    lines.push(`Limit: **${result.playlistLimit}** (von ${result.playlistTotal})`);
  }

  if (result.firstTrackLabel) {
    lines.push(
      result.queued
        ? `Als nächstes: ${result.firstTrackLabel}`
        : `Spiele jetzt: ${result.firstTrackLabel}`
    );
  }

  if (result.queued && Number.isFinite(result.queuedCount)) {
    lines.push(`In Queue: **${result.queuedCount}**`);
  }

  const message = await interaction.editReply({
    embeds: [
      buildActionEmbed({
        title: "Playlist hinzugefügt",
        emoji: "📚",
        description: lines.join("\n"),
      }),
    ],
  });

  rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
  return message;
}

async function handlePause(interaction, ctx, musicService) {
  log("info", "[Slash] pause", ctx);
  if (!ensureSameVoiceChannel(interaction)) return;

  const res = await musicService.pause({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Kein Player aktiv.");
  }
  if (!res.ok && res.reason === "ALREADY_PAUSED") {
    return replyEphemeral(interaction, "Schon pausiert.");
  }

  return interaction.reply({
    embeds: [buildActionEmbed({ title: "Pausiert", emoji: "⏸️", description: "Wiedergabe pausiert." })],
  });
}

async function handleResume(interaction, ctx, musicService) {
  log("info", "[Slash] resume", ctx);
  if (!ensureSameVoiceChannel(interaction)) return;

  const res = await musicService.resume({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Kein Player aktiv.");
  }
  if (!res.ok && res.reason === "NOT_PAUSED") {
    return replyEphemeral(interaction, "Nichts ist pausiert.");
  }

  return interaction.reply({
    embeds: [buildActionEmbed({ title: "Weiter geht's", emoji: "▶️", description: "Wiedergabe fortgesetzt." })],
  });
}

async function handleStop(interaction, ctx, musicService) {
  log("info", "[Slash] stop", ctx);
  if (!ensureSameVoiceChannel(interaction)) return;

  const res = await musicService.stop({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Kein Player aktiv.");
  }

  const message = await interaction
    .reply({
      embeds: [
        buildActionEmbed({
          title: "Gestoppt",
          emoji: "⏹️",
          description: "Wiedergabe gestoppt und Queue geleert.",
        }),
      ],
    })
    .then(() => interaction.fetchReply().catch(() => null));

  rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
  return message;
}

async function handleVolume(interaction, ctx, musicService) {
  log("info", "[Slash] volume", ctx);
  if (!ensureSameVoiceChannel(interaction)) return;

  const volume = interaction.options.getInteger("value", true);
  const res = await musicService.volume({ guildId: interaction.guildId, volume });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Kein Player aktiv.");
  }
  if (!res.ok) {
    return replyEphemeral(interaction, describeUserFacingFailure(res, "volume"));
  }

  const message = await interaction
    .reply({
      embeds: [
        buildActionEmbed({
          title: "Lautstärke gesetzt",
          emoji: "🔊",
          description: `Neue Lautstärke: **${res.volume}%**`,
        }),
      ],
    })
    .then(() => interaction.fetchReply().catch(() => null));

  rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
  return message;
}

function handleNowPlaying(interaction, _ctx, musicService) {
  if (!ensureSameVoiceChannel(interaction)) return;
  const res = getNowPlayingSafe(musicService, interaction.guildId);
  if (!res.ok || !res.track) {
    return replyEphemeral(interaction, "Gerade läuft nichts.");
  }

  return interaction
    .reply({ embeds: [buildNowPlayingEmbed(res.track)] })
    .then(() => interaction.fetchReply().catch(() => null))
    .then((message) => {
      rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
      return message;
    });
}

const slashHandlers = {
  join: handleJoin,
  play: handlePlay,
  playlist: handlePlaylist,
  skip: handleSkip,
  leave: handleLeave,
  queue: handleQueue,
  pause: handlePause,
  resume: handleResume,
  stop: handleStop,
  volume: handleVolume,
  nowplaying: handleNowPlaying,
};

async function handleButton(interaction, ctx, musicService) {
  const [prefix, targetGuildId, action] = (interaction.customId || "").split(":");
  if (prefix !== "np") return;
  if (!ensureSameVoiceChannel(interaction)) return;
  if (targetGuildId && targetGuildId !== interaction.guildId) {
    return replyEphemeral(interaction, "Dieser Button gehört zu einem anderen Server.");
  }

  log("info", "[Button] action", { ...ctx, action });

  if (action === CONTROL_ACTIONS.pause) {
    const res = await musicService.pause({ guildId: interaction.guildId });
    if (!res.ok && res.reason === "NO_PLAYER") {
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Nichts zu pausieren", emoji: "🚫", description: "Kein Player aktiv." })],
        flags: EPHEMERAL,
      });
    }
    if (!res.ok && res.reason === "ALREADY_PAUSED") {
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Schon pausiert", emoji: "⏸️", description: "Die Wiedergabe ist bereits pausiert." })],
        flags: EPHEMERAL,
      });
    }

    return interaction.reply({
      embeds: [buildActionEmbed({ title: "Pausiert", emoji: "⏸️", description: "Wiedergabe pausiert." })],
      flags: EPHEMERAL,
    });
  }

  if (action === CONTROL_ACTIONS.resume) {
    const res = await musicService.resume({ guildId: interaction.guildId });
    if (!res.ok && res.reason === "NO_PLAYER") {
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Kein Player", emoji: "🚫", description: "Derzeit läuft nichts." })],
        flags: EPHEMERAL,
      });
    }
    if (!res.ok && res.reason === "NOT_PAUSED") {
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Nichts pausiert", emoji: "▶️", description: "Es gibt nichts fortzusetzen." })],
        flags: EPHEMERAL,
      });
    }

    return interaction.reply({
      embeds: [buildActionEmbed({ title: "Weiter geht's", emoji: "▶️", description: "Wiedergabe fortgesetzt." })],
      flags: EPHEMERAL,
    });
  }

  if (action === CONTROL_ACTIONS.skip) {
    const res = await musicService.skip({ guildId: interaction.guildId });
    if (!res.ok)
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Kein Player", emoji: "🚫", description: "Es läuft gerade nichts." })],
        flags: EPHEMERAL,
      });

    const description = res.next
      ? `Als nächstes: ${res.next}`
      : "Keine weiteren Tracks in der Queue.";

    return interaction.reply({
      embeds: [buildActionEmbed({ title: "Übersprungen", emoji: "⏭️", description })],
      flags: EPHEMERAL,
    });
  }

  if (action === CONTROL_ACTIONS.queue) {
    const snap = getQueueSnapshotSafe(musicService, interaction.guildId);
    if (!snap.nowPlaying && snap.items.length === 0) {
      return interaction.reply({ embeds: [buildQueueEmbed(snap)], flags: EPHEMERAL });
    }

    return interaction.reply({ embeds: [buildQueueEmbed(snap)], flags: EPHEMERAL });
  }

  if (action === CONTROL_ACTIONS.stop) {
    const res = await musicService.stop({ guildId: interaction.guildId });
    if (!res.ok && res.reason === "NO_PLAYER") {
      return interaction.reply({
        embeds: [buildActionEmbed({ title: "Kein Player", emoji: "🚫", description: "Es läuft gerade nichts." })],
        flags: EPHEMERAL,
      });
    }

    return interaction.reply({
      embeds: [buildActionEmbed({ title: "Gestoppt", emoji: "⏹️", description: "Wiedergabe gestoppt und Queue geleert." })],
      flags: EPHEMERAL,
    });
  }

  return replyEphemeral(interaction, "Unbekannte Aktion.");
}

async function handleSearchSelect(interaction, ctx, musicService) {
  const [prefix, token, allowedUser] = (interaction.customId || "").split(":");
  if (prefix !== "pick") return;
  if (!ensureSameVoiceChannel(interaction)) return;

  if (allowedUser && allowedUser !== interaction.user?.id) {
    return replyEphemeral(interaction, "Nur der Nutzer, der gesucht hat, darf auswählen.");
  }

  const rawValue = interaction.values?.[0];
  const choiceIndex = Number(rawValue);

  if (Number.isNaN(choiceIndex)) {
    return replyEphemeral(interaction, "Ungültige Auswahl.");
  }

  log("info", "[Select] search choice", { ...ctx, choiceIndex });

  const res = await musicService.completeSearchSelection({
    guildId: interaction.guildId,
    token,
    choiceIndex,
  });

  if (!res.ok) {
    return replyEphemeral(interaction, "Auswahl nicht mehr gültig. Bitte erneut suchen.");
  }

  const message = await interaction.update({
    embeds: res.queued
      ? [buildQueuedEmbed(res.display, res.queuePosition)]
      : [
          buildActionEmbed({
            title: "Spiele jetzt",
            emoji: "▶️",
            description: res.display || "Track wird abgespielt.",
          }),
        ],
    components: [],
  });

  if (res.queued) {
    rememberStatusMessage(interaction.guildId, message, interaction.client, undefined, musicService);
    return message;
  }

  return interaction.deleteReply().catch(() => {});
}

export function setupInteractionHandler(client, musicService) {
  cachedMusicService = musicService;

  const required = [
    "ensureReady",
    "join",
    "play",
    "playPlaylist",
    "skip",
    "leave",
    "pause",
    "resume",
    "stop",
    "volume",
    "getQueueSnapshot",
    "getNowPlaying",
    "completeSearchSelection",
    "clearSessionMessages",
    "untrackStatusMessage",
  ];
  const missing = required.filter((m) => typeof musicService?.[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`Music service missing methods: ${missing.join(", ")}`);
  }

  // Zentraler Handler für Slash-Commands und Buttons (Playback-Steuerung).
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const ctx = {
      cmd: interaction.isChatInputCommand()
        ? interaction.commandName
        : interaction.customId || (interaction.isStringSelectMenu() ? "select" : "unknown"),
      guild: interaction.guildId,
      user: interaction.user?.id,
    };

    try {
      if (ensureCommandOnGuild(interaction)) return;

      try {
        await musicService.ensureReady();
      } catch (e) {
        log("warn", "[Interaction] Lavalink not ready", { ...ctx, err: errToObj(e) });
        return replyEphemeral(
          interaction,
          "Lavalink verbindet sich noch – bitte in ein paar Sekunden erneut versuchen."
        );
      }

      if (interaction.isChatInputCommand()) {
        const handler = slashHandlers[interaction.commandName];
        if (handler) return handler(interaction, ctx, musicService);
        return replyEphemeral(interaction, "Unbekannter Command.");
      }

      if (interaction.isButton()) {
        return handleButton(interaction, ctx, musicService);
      }

      if (interaction.isStringSelectMenu()) {
        return handleSearchSelect(interaction, ctx, musicService);
      }

      return replyEphemeral(interaction, "Unbekannter Command.");
    } catch (e) {
      const errorId = Math.random().toString(36).slice(2, 8);
      log("error", "[Slash] handler failed", { ...ctx, err: errToObj(e), errorId });

      // Spezifische, bessere Fehlermeldung für Voice-Join-Timeout
      const friendly = isVoiceJoinTimeout(e)
        ? `🚫 Ich konnte dem Voice-Channel nicht beitreten (z.B. voll oder blockiert). (Fehler-ID: ${errorId})`
        : `💥 Unerwarteter Fehler (ID: ${errorId})${e?.message ? `: ${e.message}` : ". Siehe Logs."}`;

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(friendly);
        } else {
          await replyEphemeral(interaction, friendly);
        }
      } catch {
        // ignore
      }
    }
  });
}
