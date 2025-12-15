// src/index.js
// Einstiegspunkt des Bots: Initialisiert Discord- und Lavalink-Clients,
// verdrahtet Event-Handler und stößt die Registrierung der Slash-Commands an.
import { Events } from "discord.js";

import { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, LAVALINK, LOG_LEVEL } from "./config/index.js";
import { log, errToObj } from "./utils/logger.js";

import { createDiscordClient } from "./infra/discord/client.js";
import { createShoukaku } from "./infra/lavalink/shoukaku.js";

import { createMusicService } from "./services/musicService.js";
import { registerSlashCommands } from "./app/registerCommands.js";
import { setupInteractionHandler } from "./app/interactionHandler.js";

// --- Process-level logging ---
// Sicherheitsnetz, damit ungefangene Fehler nicht untergehen und sauber
// geloggt werden.
process.on("unhandledRejection", (reason) => log("error", "[Process] UnhandledRejection", reason));
process.on("uncaughtException", (e) => {
  log("error", "[Process] UncaughtException", errToObj(e));
  process.exitCode = 1;
});

// --- Startup logs ---
// Frühzeitige Info über Runtime-Parameter, damit Diagnosen im Betrieb einfacher sind.
log("info", "Starting NichMuski…", {
  logLevel: LOG_LEVEL,
  lavalink: { host: LAVALINK.host, port: LAVALINK.port, secure: LAVALINK.secure },
  hasToken: Boolean(DISCORD_TOKEN),
  hasClientId: Boolean(CLIENT_ID),
  guildId: GUILD_ID || null,
});

// Ohne Token kann der Bot nicht starten, daher harter Exit.
if (!DISCORD_TOKEN) {
  log("error", "DISCORD_TOKEN fehlt. Container wird sich gleich wieder verabschieden.");
  process.exit(1);
}
// Ohne Client ID kann lediglich die Command-Registrierung nicht stattfinden.
if (!CLIENT_ID) {
  log("warn", "CLIENT_ID fehlt -> Commands werden nicht registriert (Bot läuft trotzdem).");
}

// --- Build core ---
// Einzelne Bausteine initialisieren, die weiter unten miteinander verknüpft werden.
const client = createDiscordClient();
const shoukaku = createShoukaku(client);
const musicService = createMusicService(shoukaku, client);

// --- Wire handlers ---
// Slash-Command-Handler mit Discord-Client und Music-Service verbinden.
setupInteractionHandler(client, musicService);

// --- Ready hook ---
// Sobald Discord ready meldet, Commands registrieren und ein paar Kennzahlen loggen.
client.once(Events.ClientReady, async () => {
  log("info", `Logged in as ${client.user.tag}`, {
    botId: client.user.id,
    guilds: client.guilds.cache.size,
  });

  try {
    await registerSlashCommands();
  } catch (e) {
    log("error", "[Discord] Slash command registration failed (startup)", errToObj(e));
  }
});

// --- Login ---
client.login(DISCORD_TOKEN);
