// src/infra/status/sender.js
// Periodisch Status an die Website senden.
import { log, errToObj } from "../../utils/logger.js";

export function startStatusReporter({ url, token, intervalMs = 15000, getSnapshot }) {
  if (!url || !token || typeof getSnapshot !== "function") {
    log("info", "[Status] Reporter disabled (missing config)");
    return null;
  }

  const normalizedInterval = Number.isFinite(intervalMs) && intervalMs > 3000 ? intervalMs : 15000;

  const send = async () => {
    try {
      const snapshot = getSnapshot();
      const payload = {
        sentAt: new Date().toISOString(),
        ...snapshot,
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bot-token": token,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        log("warn", "[Status] Send failed", { status: res.status });
      }
    } catch (e) {
      log("warn", "[Status] Send exception", errToObj(e));
    }
  };

  send().catch(() => {});
  const timer = setInterval(() => {
    send().catch(() => {});
  }, normalizedInterval);

  return { stop: () => clearInterval(timer) };
}
