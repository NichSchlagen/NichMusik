// src/config/index.js
// Zentrale Stelle für Environment-Variablen inkl. Fallbacks.

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// --- Discord ---
export const DISCORD_TOKEN = env("DISCORD_TOKEN");
export const CLIENT_ID = env("CLIENT_ID");
export const GUILD_ID = env("GUILD_ID") || null;

// --- Lavalink ---
export const LAVALINK = {
  host: env("LAVALINK_HOST", "lavalink"),
  port: Number(env("LAVALINK_PORT", 2333)),
  password: env("LAVALINK_PASSWORD"),
  secure: env("LAVALINK_SECURE", "false").toLowerCase() === "true",
};

// --- Logging ---
export const LOG_LEVEL = env("LOG_LEVEL", "info").toLowerCase();

export const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// --- Discord constants ---
export const EPHEMERAL = 64;

// --- Bot ---
export const AUTO_LEAVE_MS = Number(env("AUTO_LEAVE_MS", 120000));
