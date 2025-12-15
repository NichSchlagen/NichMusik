// src/infra/lavalink/shoukaku.js
// Baut die Verbindung zu Lavalink und kümmert sich um Logging der wichtigsten Events.
import { Shoukaku, Connectors } from "shoukaku";
import { LAVALINK } from "../../config/index.js";
import { log, errToObj } from "../../utils/logger.js";

/**
 * Baut eine Shoukaku-Instanz inkl. Lavalink Node config + Logging-Events.
 * @param {import("discord.js").Client} client
 */
export function createShoukaku(client) {
  const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client),
    [
      {
        name: "main",
        url: `${LAVALINK.host}:${LAVALINK.port}`,
        auth: LAVALINK.password,
        secure: LAVALINK.secure,
      },
    ],
    {
      moveOnDisconnect: true,
      reconnectTries: 10,
      reconnectInterval: 5000,
    }
  );

  // --- Shoukaku/Lavalink logging ---
  shoukaku.on("ready", (name) => log("info", `[Lavalink] Node ready: ${name}`));
  shoukaku.on("close", (name, code, reason) =>
    log("warn", `[Lavalink] Node closed: ${name}`, { code, reason })
  );
  shoukaku.on("reconnecting", (name, triesLeft) =>
    log("warn", `[Lavalink] Reconnecting: ${name}`, { triesLeft })
  );
  shoukaku.on("disconnect", (name, count) =>
    log("warn", `[Lavalink] Disconnected: ${name}`, { count })
  );
  shoukaku.on("error", (name, e) =>
    log("error", `[Lavalink] Error on ${name}`, errToObj(e))
  );

  return shoukaku;
}
