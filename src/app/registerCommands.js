// src/app/registerCommands.js
// Enthält die einmalige Slash-Command-Registrierung beim Discord-API-Endpunkt.
import { REST, Routes } from "discord.js";
import { CLIENT_ID, DISCORD_TOKEN, GUILD_ID } from "../config/index.js";
import { log, errToObj } from "../utils/logger.js";
import { slashCommands } from "./slashCommands.js";

/**
 * Registriert die Slash-Commands entweder guild- oder global-weit, abhängig
 * von der vorhandenen Konfiguration. Die Funktion ist safe-to-call beim
 * Startup und protokolliert fehlende Tokens/IDs explizit.
 */
export async function registerSlashCommands() {
  if (!CLIENT_ID) {
    log("warn", "CLIENT_ID fehlt -> Slash-Commands werden NICHT registriert.");
    return;
  }
  if (!DISCORD_TOKEN) {
    log("warn", "DISCORD_TOKEN fehlt -> Slash-Commands werden NICHT registriert.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: slashCommands,
      });
      log("info", "[Discord] Registered GUILD slash commands", { guildId: GUILD_ID });
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: slashCommands,
      });
      log("info", "[Discord] Registered GLOBAL slash commands (kann dauern)");
    }
  } catch (e) {
    log("error", "[Discord] Slash command registration failed", errToObj(e));
    throw e;
  }
}
