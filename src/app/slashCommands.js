// src/app/slashCommands.js
import { SlashCommandBuilder } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot joint deinen Voice-Channel"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Spielt einen Song/URL ab")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("Suchbegriff oder URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skippt den aktuellen Track"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Bot verlässt den Voice-Channel"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Zeigt die aktuelle Warteschlange"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pausiert die Wiedergabe"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Setzt die Wiedergabe fort"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stoppt die Wiedergabe und leert die Queue"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Zeigt den aktuell laufenden Track"),
].map((c) => c.toJSON());
