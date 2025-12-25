// src/infra/health/server.js
// Minimaler Health-Endpoint für Monitoring/Deploy-Checks.
import { createServer } from "node:http";
import { log, errToObj } from "../../utils/logger.js";

export function startHealthServer({ port, getSnapshot }) {
  const normalizedPort = Number(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) return null;

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    if (req.url !== "/" && req.url !== "/health") {
      res.statusCode = 404;
      res.end();
      return;
    }

    let snapshot = {};
    try {
      snapshot = typeof getSnapshot === "function" ? getSnapshot() : {};
    } catch (e) {
      log("error", "[Health] Snapshot failed", errToObj(e));
      snapshot = { error: "snapshot_failed" };
    }

    const payload = {
      ok: true,
      ts: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      ...snapshot,
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  });

  server.on("error", (e) => log("error", "[Health] Server error", errToObj(e)));
  server.listen(normalizedPort, () => {
    log("info", "[Health] Server listening", { port: normalizedPort });
  });

  return server;
}
