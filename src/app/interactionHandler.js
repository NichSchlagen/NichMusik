// src/app/interactionHandler.js
// Zentrales Routing der Slash-Commands und Schutz vor typischen Voice-Fehlern.
import { Events, PermissionsBitField } from "discord.js";
import { EPHEMERAL } from "../config/index.js";
import { log, errToObj } from "../utils/logger.js";
import { CONTROL_ACTIONS } from "./constants.js";
import {
  buildActionEmbed,
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildQueuedEmbed,
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

  if (kind === "join") {
    return `🚫 Konnte dem Voice-Channel nicht beitreten${detail ? ` (${detail})` : "."}`;
  }

  if (kind === "play") {
    return `🚫 Song konnte nicht gestartet werden${detail ? ` (${detail})` : "."}`;
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

  return interaction.reply({
    embeds: [
      buildActionEmbed({
        title: "Voice beigetreten",
        emoji: "✅",
        description: `Bin dem Voice-Channel **${vc.name}** beigetreten. Sag mir, was ich spielen soll!`,
      }),
    ],
  });
}

async function handlePlay(interaction, ctx, musicService) {
  const query = interaction.options.getString("query", true);
  const vc = ensureVoiceChannel(interaction);
  if (!vc) return;

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

  const label = result.display || `**${result.title || "Unbekannt"}**`;

  if (!result.queued) {
    return interaction.deleteReply().catch(() => {});
  }

  return interaction.editReply({ embeds: [buildQueuedEmbed(label, result.queuePosition)] });
}

async function handleSkip(interaction, ctx, musicService) {
  log("info", "[Slash] skip", ctx);

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

  const res = await musicService.leave({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Ich bin nicht im Voice.");
  }
  if (!res.ok && res.reason === "NO_DISCONNECT_METHOD") {
    throw new Error("No disconnect method found (player.disconnect / shoukaku.leaveVoiceChannel).");
  }

  return interaction.reply({
    embeds: [
      buildActionEmbed({
        title: "Voice verlassen",
        emoji: "🛑",
        description: "Playback gestoppt, Queue geleert und Voice verlassen. Bis bald!",
      }),
    ],
  });
}

function handleQueue(interaction, _ctx, musicService) {
  const snap = getQueueSnapshotSafe(musicService, interaction.guildId);

  if (!snap.nowPlaying && snap.items.length === 0) {
    return interaction.reply({
      embeds: [buildQueueEmbed(snap)],
      flags: EPHEMERAL,
    });
  }

  return interaction.reply({ embeds: [buildQueueEmbed(snap)] });
}

async function handlePause(interaction, ctx, musicService) {
  log("info", "[Slash] pause", ctx);

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

  const res = await musicService.stop({ guildId: interaction.guildId });
  if (!res.ok && res.reason === "NO_PLAYER") {
    return replyEphemeral(interaction, "Kein Player aktiv.");
  }

  return interaction.reply({
    embeds: [
      buildActionEmbed({
        title: "Gestoppt",
        emoji: "⏹️",
        description: "Wiedergabe gestoppt und Queue geleert.",
      }),
    ],
  });
}

function handleNowPlaying(interaction, _ctx, musicService) {
  const res = getNowPlayingSafe(musicService, interaction.guildId);
  if (!res.ok || !res.track) {
    return replyEphemeral(interaction, "Gerade läuft nichts.");
  }

  return interaction.reply({ embeds: [buildNowPlayingEmbed(res.track)] });
}

const slashHandlers = {
  join: handleJoin,
  play: handlePlay,
  skip: handleSkip,
  leave: handleLeave,
  queue: handleQueue,
  pause: handlePause,
  resume: handleResume,
  stop: handleStop,
  nowplaying: handleNowPlaying,
};

async function handleButton(interaction, ctx, musicService) {
  const [prefix, targetGuildId, action] = (interaction.customId || "").split(":");
  if (prefix !== "np") return;
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

export function setupInteractionHandler(client, musicService) {
  cachedMusicService = musicService;

  const required = ["ensureReady", "join", "play", "skip", "leave", "pause", "resume", "stop", "getQueueSnapshot", "getNowPlaying"];
  const missing = required.filter((m) => typeof musicService?.[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`Music service missing methods: ${missing.join(", ")}`);
  }

  // Zentraler Handler für Slash-Commands und Buttons (Playback-Steuerung).
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    const ctx = {
      cmd: interaction.isChatInputCommand() ? interaction.commandName : interaction.customId,
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
