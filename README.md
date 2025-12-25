# NichMusik

NichMusik ist ein schlanker Discord-Music-Bot, der mit [discord.js](https://discord.js.org/) und [Shoukaku](https://github.com/Deivu/Shoukaku) auf einem Lavalink-Backend aufbaut. Er bringt nur die nötigsten Slash-Commands mit, um schnell Musik in deinen Voice-Channels abzuspielen.

## Features
- Neun schlanke Slash-Commands für Playback, Queue-Ansicht und Steuerung
- "Now Playing"-Nachricht mit Buttons (Pause/Resume/Skip/Queue/Stop)
- Automatisches Joinen/Leaven von Voice-Channels und Auto-Leave bei Inaktivität
- YouTube-Suche plus Spotify-Fallback (wandelt Spotify-Links in eine YouTube-Suche um)
- SoundCloud-Support ohne Premium-Filter

## Voraussetzungen
- Node.js 18+ (wegen ES Modules)
- Ein Lavalink-Server (z. B. per Docker, siehe unten)
- Discord-Bot-Token und eine Application ID

## Konfiguration
Der Bot liest seine Einstellungen über Umgebungsvariablen (siehe `src/config/index.js`):

| Variable | Beschreibung | Default |
| --- | --- | --- |
| `DISCORD_TOKEN` | Token des Bots | — (Pflicht) |
| `CLIENT_ID` | Application-/Client-ID, wird für die Command-Registrierung genutzt | — (empfohlen) |
| `GUILD_ID` | Wenn gesetzt, werden Slash-Commands nur in dieser Guild registriert (sonst global) | leer |
| `LAVALINK_HOST` | Hostname/Service-Name des Lavalink-Servers | `lavalink` |
| `LAVALINK_PORT` | Port des Lavalink-Servers | `2333` |
| `LAVALINK_PASSWORD` | Passwort für Lavalink | — |
| `LAVALINK_SECURE` | `true` wenn TLS genutzt werden soll | `false` |
| `LOG_LEVEL` | `debug`, `info`, `warn` oder `error` | `info` |
| `AUTO_LEAVE_MS` | Zeit bis zum automatischen Verlassen bei Inaktivität (ms) | `120000` |
| `HEALTH_PORT` | Optionaler Port für den Health-Endpoint | `0` (deaktiviert) |
| `PLAYLIST_MAX_TRACKS` | Max. Anzahl Tracks pro Playlist | `200` |

### Beispiel-`.env`
```env
DISCORD_TOKEN=dein_token
CLIENT_ID=deine_client_id
GUILD_ID=deine_guild_id # optional, verkürzt die Command-Registrierung im Testbetrieb
LAVALINK_PASSWORD=changeme
LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_SECURE=false
LOG_LEVEL=info
HEALTH_PORT=3001
PLAYLIST_MAX_TRACKS=200
```

## Lokales Setup
1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```
2. Lavalink bereitstellen (Beispiel mit Docker):
   ```bash
   docker run -p 2333:2333 -e SERVER_PORT=2333 -e LAVALINK_SERVER_PASSWORD=changeme ghcr.io/lavalink-devs/lavalink:4
   ```
3. Umgebungsvariablen setzen (z. B. in einer `.env`):
   ```bash
   export DISCORD_TOKEN=dein_token
   export CLIENT_ID=deine_client_id
   export LAVALINK_PASSWORD=changeme
   ```
4. Bot starten:
   ```bash
   npm start
   ```

Beim ersten Start registriert der Bot die Slash-Commands automatisch. Mit gesetzter `GUILD_ID` erfolgt das in der angegebenen Guild (schnell), andernfalls global (kann bis zu einer Stunde dauern).

## Unterstützte Quellen
- **YouTube**: URLs werden normalisiert, reine Suchbegriffe automatisch zu einer YouTube-Suche umgewandelt.
- **Spotify**: Links werden geparst und in eine YouTube-Suche übersetzt, damit Lavalink immer etwas Abspielbares bekommt.
- **SoundCloud**: Wird direkt an Lavalink durchgereicht (inkl. Playlists), ohne Premium-Einschränkungen zu filtern.
- **Playlists**: YouTube- und SoundCloud-Playlists werden als Queue geladen.

## Slash-Commands
- `/join` – Bot joint deinen aktuellen Voice-Channel.
- `/play <query|url>` – Spielt einen Song/URL ab oder stellt ihn in die Queue; der Text-Channel wird für "Now Playing"-Updates gemerkt.
- `/playlist <url>` – Spielt eine Playlist-URL ab (YouTube/SoundCloud) und lädt mehrere Tracks in die Queue.
- `/skip` – Überspringt den aktuellen Track und springt zum nächsten Queue-Eintrag.
- `/leave` – Bot verlässt den Voice-Channel und leert die Queue.
- `/queue` – Zeigt aktuell spielenden Titel und die nächsten Einträge (max. 10).
- `/pause` – Pausiert die Wiedergabe.
- `/resume` – Setzt die Wiedergabe fort.
- `/stop` – Stoppt die Wiedergabe, leert die Queue, bleibt aber im Voice.
- `/nowplaying` – Zeigt den aktuell laufenden Track.

### Now-Playing-Buttons
Bei `/play` sendet der Bot im genutzten Text-Channel eine kompakte "Now Playing"-Nachricht mit Buttons:

- ⏸️ Pause / ▶️ Fortsetzen
- ⏭️ Skip
- 📜 Queue anzeigen (inkl. nächster Titel)
- ⏹️ Stop

Buttons sind pro Guild gebunden, damit nur die eigene Session gesteuert wird.

### Queue & Auto-Leave
- Queues werden pro Guild verwaltet; bis zu 10 Einträge werden in `/queue` dargestellt.
- Ist nichts mehr zu spielen, startet ein Auto-Leave-Timer (`AUTO_LEAVE_MS`, Standard 2 Minuten) und der Bot verlässt den Voice-Channel, sobald Queue und Player leer sind.

## Entwicklung
- Code-Stil: ES Modules, keine globalen State-Singletons außerhalb der bestehenden Services.
- Slash-Commands und Interaktionslogik befinden sich unter `src/app`, Infrastruktur in `src/infra`, Services in `src/services`.
- Für lokale Iterationen genügt `npm start`; der Bot reagiert unmittelbar auf Codeänderungen nach einem Neustart.

## Deployment mit docker-compose
Das Repository enthält ein Beispiel-Setup (`docker-compose.yml`) für Bot und Lavalink. Erstelle eine `.env` mit den benötigten Variablen (mindestens `DISCORD_TOKEN`, `CLIENT_ID`, `LAVALINK_PASSWORD`) und starte dann:

```bash
docker compose up -d
```

Lavalink wird als interner Service gestartet; der Bot wartet, bis der Healthcheck erfolgreich ist.

## Logging & Fehlerbehandlung
- Log-Level über `LOG_LEVEL` konfigurierbar.
- Unhandled rejections/exceptions werden auf Prozess-Ebene geloggt.
- Der Bot versucht, hilfreiche Fehlermeldungen für Voice-Join-Probleme zurückzugeben.

## Health-Endpoint
Wenn `HEALTH_PORT` gesetzt ist, startet der Bot einen JSON-Healthcheck unter `http://localhost:<port>/health`.

## Lizenz

Dieses Projekt steht unter der **MIT License**.

Du darfst den Code frei nutzen, verändern und weiterverbreiten – auch kommerziell – solange der Copyright-Hinweis und der Lizenztext erhalten bleiben.

Siehe die Datei [`LICENSE`](./LICENSE) für Details.
