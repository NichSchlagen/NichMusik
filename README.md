# NichMusik

NichMusik ist ein schlanker Discord-Music-Bot auf Basis von [discord.js](https://discord.js.org/) und [Shoukaku](https://github.com/Deivu/Shoukaku) mit Lavalink als Backend. Fokus: schnelle, stabile Musikfunktionen ohne unnötigen Overhead.

## Features
- Slash-Commands für Playback, Queue, Playlist und Volume
- Now-Playing-Posts mit Buttons (Pause/Resume/Skip/Queue/Stop)
- Auto-Leave bei Inaktivität (konfigurierbar)
- YouTube-Suche plus Spotify-Fallback (Spotify-Links werden in YouTube-Suche übersetzt)
- SoundCloud-Support inkl. Playlists
- Auto-DJ optional: füllt die Queue mit ähnlichen Tracks, wenn sie leer ist
- Health-Endpoint für einfache Deploy-Checks

## Voraussetzungen
- Node.js 18+
- Lavalink-Server (z. B. via Docker)
- Discord-Bot-Token und Application ID

## Quickstart (lokal)
1) Abhängigkeiten installieren:
```bash
npm install
```
2) Lavalink starten (Beispiel):
```bash
docker run -p 2333:2333 -e SERVER_PORT=2333 -e LAVALINK_SERVER_PASSWORD=changeme ghcr.io/lavalink-devs/lavalink:4
```
3) `.env` anlegen:
```env
DISCORD_TOKEN=dein_token
CLIENT_ID=deine_client_id
LAVALINK_PASSWORD=changeme
```
4) Bot starten:
```bash
npm start
```

Beim ersten Start registriert der Bot die Slash-Commands automatisch. Mit `GUILD_ID` werden sie sofort in der angegebenen Guild registriert, global kann es bis zu einer Stunde dauern.

## Konfiguration
Alle Werte kommen aus `src/config/index.js`.

| Variable | Beschreibung | Default |
| --- | --- | --- |
| `DISCORD_TOKEN` | Token des Bots | — (Pflicht) |
| `CLIENT_ID` | Application-/Client-ID | — (empfohlen) |
| `GUILD_ID` | Commands nur in dieser Guild registrieren | leer |
| `LAVALINK_HOST` | Lavalink Host | `lavalink` |
| `LAVALINK_PORT` | Lavalink Port | `2333` |
| `LAVALINK_PASSWORD` | Lavalink Passwort | — |
| `LAVALINK_SECURE` | TLS aktivieren | `false` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `AUTO_LEAVE_MS` | Auto-Leave Delay (ms) | `120000` |
| `HEALTH_PORT` | Health-Endpoint Port | `0` (aus) |
| `PLAYLIST_MAX_TRACKS` | Max. Tracks pro Playlist | `200` |
| `AUTO_DJ` | Auto-DJ aktivieren | `false` |
| `AUTO_DJ_MAX_TRACKS` | Tracks, die Auto-DJ nachlädt | `5` |

Beispiel:
```env
DISCORD_TOKEN=dein_token
CLIENT_ID=deine_client_id
GUILD_ID=deine_guild_id
LAVALINK_PASSWORD=changeme
LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_SECURE=false
LOG_LEVEL=info
AUTO_LEAVE_MS=120000
PLAYLIST_MAX_TRACKS=200
AUTO_DJ=true
AUTO_DJ_MAX_TRACKS=5
HEALTH_PORT=3001
```

## Slash-Commands (Details)
- `/join` – Bot joint deinen Voice-Channel
- `/play <query|url>` – Spielt einen Song oder queued ihn; Suchbegriffe werden als `ytsearch:` behandelt
- `/playlist <url>` – Lädt eine Playlist in die Queue (YouTube/SoundCloud)
- `/skip` – Überspringt den aktuellen Track
- `/leave` – Bot verlässt den Voice-Channel und leert die Queue
- `/queue` – Zeigt aktuellen Track + nächste Einträge (max. 10, mit sicherem Kürzen)
- `/pause` – Pause
- `/resume` – Weiter
- `/stop` – Stoppt die Wiedergabe, leert die Queue
- `/volume <0-100>` – Setzt die Lautstärke
- `/nowplaying` – Zeigt den aktuellen Track

## Now-Playing & Buttons
Bei `/play` sendet der Bot im Text-Channel eine Now-Playing-Nachricht mit Buttons:
- Pause / Resume
- Skip
- Queue
- Stop

Buttons sind pro Guild gebunden und nur für die aktuelle Session gültig.

## Quellen & Playlists
- **YouTube**: URLs oder Suchstrings; Suchstrings werden automatisch zu `ytsearch:`
- **Spotify**: Links werden über die oEmbed-API aufbereitet und in eine YouTube-Suche übersetzt
- **SoundCloud**: Direkte Links und Playlists
- **Playlists**: YouTube- und SoundCloud-Playlists werden als Queue geladen (begrenzt durch `PLAYLIST_MAX_TRACKS`)

## Auto-DJ (Details)
Wenn `AUTO_DJ=true`, füllt der Bot die Queue nach, sobald sie leer ist:
- Seed ist der zuletzt gespielte Track
- Es wird eine YouTube-Suche mit `"<title> <author> mix"` durchgeführt
- Es werden bis zu `AUTO_DJ_MAX_TRACKS` Tracks eingereiht
- `/stop` deaktiviert Auto-DJ für diese Session; beim nächsten `/play` wird es wieder aktiviert

## Health-Endpoint
Setze `HEALTH_PORT`, um `http://localhost:<port>/health` zu aktivieren.  
Der Endpoint liefert einen JSON-Snapshot mit Node-Status, Queue-Größen und Sessions.

## Docker-Deployment
Das Repository enthält `docker-compose.yml` (Bot + Lavalink).
```bash
docker compose up -d
```
Lavalink wird als interner Service gestartet; der Bot wartet auf den Healthcheck.

## Entwicklung
- Code-Stil: ES Modules
- Struktur:
  - `src/app`: Slash-Commands, Interaction-Handling, Embeds
  - `src/infra`: Discord/Lavalink/Health Infrastruktur
  - `src/services`: Music-Service und Queue-Logik
  - `src/sources`: Resolver für YouTube/Spotify/SoundCloud
- Lint:
```bash
npm run lint
```
- Smoke-Test für Resolver:
```bash
npm run smoke
```

## Troubleshooting
- **Commands erscheinen nicht**: `CLIENT_ID` fehlt oder globaler Register dauert. Nutze `GUILD_ID` für sofortige Registrierung.
- **Keine Musik**: Lavalink erreichbar? Passwort korrekt? `LAVALINK_HOST`/`PORT` stimmen?
- **Queue-Button Fehler**: Stelle sicher, dass die Queue nicht zu lang ist; der Bot kürzt automatisch auf 1024 Zeichen pro Embed-Field.

## Lizenz
MIT License. Siehe `LICENSE`.
