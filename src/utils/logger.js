// src/utils/logger.js
// Schlanker Logger ohne Abhängigkeiten; filtert nach konfiguriertem Level.
import { LOG_LEVEL, LOG_LEVELS } from "../config/index.js";

const levelStyles = {
  debug: { color: "\x1b[36m", icon: "🐞" },
  info: { color: "\x1b[32m", icon: "ℹ️" },
  warn: { color: "\x1b[33m", icon: "⚠️" },
  error: { color: "\x1b[31m", icon: "❌" },
};

const resetColor = "\x1b[0m";

function levelOk(lvl) {
  const cur = LOG_LEVELS[LOG_LEVEL] ?? 20;
  const want = LOG_LEVELS[lvl] ?? 20;
  return want >= cur;
}

function padLevel(level) {
  return (level || "").toUpperCase().padEnd(5, " ");
}

function serializeMeta(meta) {
  if (meta === undefined) return "";
  if (typeof meta === "string") return meta;

  try {
    return JSON.stringify(
      meta,
      (key, value) => {
        if (value instanceof Error) return errToObj(value);

        if (value && typeof value === "object" && !Array.isArray(value)) {
          // keys alphabetisch sortieren, damit die Ausgabe stabiler ist
          return Object.keys(value)
            .sort()
            .reduce((acc, k) => {
              acc[k] = value[k];
              return acc;
            }, {});
        }

        return value;
      },
      2
    );
  } catch (e) {
    return String(e?.message || meta);
  }
}

export function log(level, message, meta) {
  if (!levelOk(level)) return;

  const ts = new Date().toISOString();
  const style = levelStyles[level] || {};
  const label = `${style.color || ""}${padLevel(level)}${resetColor}`;
  const icon = style.icon || "•";
  const base = `${icon} [${ts}] [${label}] ${message}`;
  const metaStr = serializeMeta(meta);

  console.log(metaStr ? `${base} ${metaStr}` : base);
}

export function errToObj(err) {
  if (!err) return err;
  // Fehler lassen sich nicht immer direkt loggen; als plain object bleiben
  // relevante Felder erhalten und JSON-serialisierbar.
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    stack: err.stack,
  };
}
