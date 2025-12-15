// src/infra/discord/client.js
// Stellt den Discord.js-Client mit den minimal notwendigen Intents bereit.
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import { log, errToObj } from "../../utils/logger.js";

/**
 * Erstellt einen konfigurierten Discord-Client inkl. grundlegendem Event-Logging,
 * damit Verbindungsprobleme schneller sichtbar werden.
 */
export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });

  // --- Discord internal logging ---
  client.on(Events.Debug, (m) => log("debug", `[Discord] ${m}`));
  client.on(Events.Warn, (m) => log("warn", `[Discord] ${m}`));
  client.on(Events.Error, (e) =>
    log("error", "[Discord] Error event", errToObj(e))
  );

  client.on(Events.ShardReady, (id) =>
    log("info", "[Discord] Shard ready", { id })
  );
  client.on(Events.ShardDisconnect, (event, id) =>
    log("warn", "[Discord] Shard disconnect", {
      id,
      code: event?.code,
      reason: event?.reason,
    })
  );
  client.on(Events.ShardReconnecting, (id) =>
    log("warn", "[Discord] Shard reconnecting", { id })
  );

  return client;
}
