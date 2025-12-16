// src/app/embeds.js
// Enthält wiederverwendbare Embed-Builder, um Discord-Antworten konsistent und übersichtlich zu halten.
import { EmbedBuilder } from "discord.js";

export const BRAND_COLOR = 0xcf0936;
const BRAND_BADGE_URL =
  "https://raw.githubusercontent.com/NichSchlagen/NichMusik/refs/heads/main/src/assets/img/nichmusik-logo.png";

function baseEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "NichMusik", iconURL: BRAND_BADGE_URL })
    .setThumbnail(BRAND_BADGE_URL)
    .setTimestamp();
}

export function buildActionEmbed({ title, description, emoji, footer }) {
  const embed = baseEmbed().setTitle(`${emoji ? `${emoji} ` : ""}${title}`);
  if (description) embed.setDescription(description);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

export function buildQueuedEmbed(trackLabel, queuePosition) {
  const description = ["✅ Zur Queue hinzugefügt:", `> ${trackLabel}`];

  if (queuePosition) {
    description.push(`Position in der Queue: **#${queuePosition}**`);
  }

  description.push("Mit **/queue** siehst du die aktuelle Liste.");

  return baseEmbed()
    .setTitle("➕ Track hinzugefügt")
    .setDescription(description.join("\n"))
    .setFooter({ text: "Tipp: /nowplaying zeigt den aktuellen Track." });
}

export function buildNowPlayingEmbed(track) {
  const label = typeof track === "string" ? track : track?.label || "Unbekannt";
  const artworkUrl = typeof track === "object" ? track?.artworkUrl : null;

  const embed = baseEmbed()
    .setTitle("🎧 Jetzt läuft")
    .setDescription(
      [
        `> ${label}`,
        "",
        "Steuerung: **/skip**, **/pause**, **/stop**",
      ].join("\n")
    )
    .setFooter({ text: "NichMusik" });

  if (artworkUrl) embed.setThumbnail(artworkUrl);

  return embed;
}

export function buildQueueEmbed(snapshot) {
  const embed = baseEmbed().setTitle("🎵 Queue");

  const nowPlaying = snapshot.nowPlaying
    ? `▶️ **Aktuell:** ${snapshot.nowPlaying}`
    : "⏹️ Aktuell läuft nichts.";
  embed.setDescription(nowPlaying);

  const upcoming = snapshot.items?.slice(0, 10) || [];
  const lines = upcoming.map((item, idx) => `**${idx + 1}.** ${item}`);

  if (!lines.length) {
    lines.push("Keine weiteren Tracks. Starte mit **/play** einen neuen Track.");
  }

  if (snapshot.items?.length > 10) {
    lines.push(`… und **${snapshot.items.length - 10}** weitere`);
  }

  embed.addFields({ name: "Als Nächstes", value: lines.join("\n") });
  embed.setFooter({ text: "Tipp: /nowplaying zeigt den aktuellen Track." });

  return embed;
}
