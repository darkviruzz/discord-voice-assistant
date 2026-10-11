// ============================================================================
// Konfigurations-Katalog — die eine Quelle der Wahrheit für das Settings-Panel.
//
// Jede in .env dokumentierte Variable ist hier mit Metadaten erfasst:
//   scope     'server' | 'bot'  — welcher Prozess die Variable liest.
//   group     Anzeige-Gruppe (Tab/Abschnitt im Panel).
//   key       exakter ENV-Variablenname (wie in .env / process.env).
//   label     kurzer, gut verständlicher Name (Überschrift der Zeile).
//   desc      ausführliche Erklärung: was bewirkt die Variable konkret.
//   type      'string' | 'number' | 'boolean' | 'enum' | 'list' — steuert das
//             Eingabe-Widget und die Validierung.
//   enumValues für type 'enum': erlaubte Werte.
//   onValue/offValue für type 'boolean': String-Repräsentation im ENV
//             (die meisten Flags nutzen 'true'/'false', DEBUG nutzt '1'/'0').
//   applyMode wann eine Änderung real greift — siehe APPLY_MODES unten.
//   secret    true = Wert nie ausliefern, nur „gesetzt/nicht gesetzt", read-only.
//   editable  false = nur anzeigen (z. B. Secrets, ungenutzte Legacy-Felder).
//   def       Default-Wert (identisch zu .env.example bzw. Code-Fallback).
//   note      optionaler Zusatzhinweis (Legacy, Sonderfall …).
//
// Das Panel rendert ausschließlich aus diesem Katalog; neue Variablen hier
// eintragen, dann erscheinen sie automatisch mit Doku + Validierung im UI.
//
// CONTRACT für neue Funktionen: Jede neue konfigurierbare Variable (Server wie
// Bot) wird GENAU SO implementiert — Katalog-Eintrag hier (mit label/desc/type/
// applyMode), gelesen wird sie im Code über process.env. Es gibt keinen zweiten
// Weg, Settings ins UI zu bringen; bot-scope-Keys zusätzlich in die
// BOT_KEYS-Whitelist des Bots (apps/bot/src/configOverrides.js) aufnehmen.
// ============================================================================

// --- Secret-Blacklist ---------------------------------------------------------
// Keys, deren Name auf ein Geheimnis hindeutet, werden IMMER wie `secret: true`
// behandelt — unabhängig davon, ob der Katalog-Eintrag das Flag setzt (oder ein
// künftiger Eintrag es vergisst). Werte solcher Keys verlassen den Prozess nie:
// die API liefert nur „gesetzt/nicht gesetzt", Schreiben über das Panel ist
// gesperrt, und der Bot schickt sie nicht im config_state-Report mit.
export const SECRET_KEY_PATTERNS = [
  /TOKEN/i, /SECRET/i, /BEARER/i, /PASSWORD/i, /(^|_)PASS(_|$)/i,
  /API_?KEY/i, /PRIVATE_?KEY/i, /CREDENTIAL/i,
];

export function isSecretKey(key) {
  const k = String(key || '');
  return SECRET_KEY_PATTERNS.some((re) => re.test(k));
}

// Effektiver Secret-Status eines Katalog-Eintrags (Flag ODER Blacklist).
export function isSecretEntry(entry) {
  return !!(entry && (entry.secret || isSecretKey(entry.key)));
}

// Wie/wann eine gespeicherte Änderung tatsächlich wirksam wird. Der Wert wird
// bei einem persistenten Speichern IMMER sofort in den Override-Layer
// geschrieben — applyMode sagt nur, ab wann der laufende Betrieb ihn benutzt.
export const APPLY_MODES = {
  live: {
    label: 'Sofort aktiv',
    desc: 'Wird bei der nächsten Operation (nächste STT-/LLM-/TTS-Anfrage bzw. '
      + 'Äußerung) neu gelesen. Kein Neustart, kein Reconnect nötig.',
  },
  'next-session': {
    label: 'Nächste Session',
    desc: 'Greift bei der nächsten Voice-Session. Läuft gerade eine Session, '
      + 'bleibt der bisherige Wert bis zu deren Ende aktiv.',
  },
  'next-finalize': {
    label: 'Nächstes Finalize',
    desc: 'Wird erst beim nächsten Finalize-Lauf (Session-Abschluss / '
      + 'Re-Finalize) ausgewertet. Beeinflusst keine bereits archivierten Sessions.',
  },
  reconnect: {
    label: 'Bot-Reconnect',
    desc: 'Der Bot liest diesen Wert nur beim Verbindungsaufbau zum Server. '
      + 'Wird gespeichert und greift, sobald der Bot sich neu verbindet '
      + '(oder neu startet).',
  },
  restart: {
    label: 'Neustart nötig',
    desc: 'Wird nur einmalig beim Prozess-Start gelesen. Wird gespeichert und '
      + 'greift erst nach einem Neustart des jeweiligen Prozesses (Server bzw. Bot).',
  },
};

// Scope-Metadaten für das UI (Legende / Persistenz-Erklärung).
export const SCOPES = {
  server: {
    label: 'Server',
    desc: 'Läuft im Server-Prozess (apps/server). Änderungen wirken direkt auf '
      + 'process.env dieses Prozesses und werden im Server-Override-Layer '
      + 'persistiert (./data/config.overrides.json → Abschnitt "server").',
  },
  bot: {
    label: 'Bot',
    desc: 'Läuft im Bot-Prozess (apps/bot) — häufig auf einem anderen Rechner. '
      + 'Änderungen werden über den Control-Kanal an verbundene Bots gepusht und '
      + 'dort im Bot-Override-Layer persistiert (DATA_DIR/config.overrides.json). '
      + 'Ist kein Bot verbunden, wird die Änderung beim nächsten Connect angewendet.',
  },
};

// --- Katalog ---------------------------------------------------------------
// Reihenfolge = Anzeige-Reihenfolge. Gruppen erscheinen in Erst-Vorkommen-Reihenfolge.

export const CATALOG = [
  // ======================= SERVER: Netzwerk / Prozess =======================
  {
    scope: 'server', group: 'Server · Netzwerk & Prozess', key: 'HOST',
    label: 'Bind-Adresse (Netzwerk-Interface)', type: 'string', def: '0.0.0.0',
    applyMode: 'restart',
    desc: 'Netzwerk-Interface, an das der HTTP/WebSocket-Server bindet. '
      + '0.0.0.0 = auf allen Interfaces erreichbar (LAN), 127.0.0.1 = nur lokal. '
      + 'Wird einmalig beim Start in server.listen() gelesen.',
  },
  {
    scope: 'server', group: 'Server · Netzwerk & Prozess', key: 'PORT',
    label: 'Server-Port', type: 'number', def: '7440', applyMode: 'restart',
    desc: 'TCP-Port für HTTP (Transkript-UI, /health) und die WebSocket-Kanäle '
      + '(/uplink, /downlink, /control). Muss zur SERVER_BASE_URL des Bots passen. '
      + 'Wird einmalig beim Start gelesen.',
  },
  {
    scope: 'server', group: 'Server · Netzwerk & Prozess', key: 'CONTROL_BEARER',
    label: 'Control-Bearer (Server↔Bot-Secret)', type: 'string', def: '',
    applyMode: 'restart', secret: true, editable: false,
    desc: 'Gemeinsames Geheimnis, mit dem sich der Bot am /uplink- und '
      + '/control-WebSocket authentifiziert. Muss identisch im Bot gesetzt sein. '
      + 'Secret — hier nur Status sichtbar, Änderung ausschließlich per .env + Neustart.',
  },
  {
    scope: 'server', group: 'Server · Netzwerk & Prozess', key: 'SESSION_SECRET',
    label: 'Session-Secret', type: 'string', def: '', applyMode: 'restart',
    secret: true, editable: false,
    note: 'Derzeit ungenutzt (in .env.example dokumentiert, aber im Code nicht referenziert).',
    desc: 'Reserviert für zukünftige Cookie-/Session-Signierung. Wird aktuell '
      + 'nirgends im Server-Code verwendet.',
  },
  {
    scope: 'server', group: 'Server · Netzwerk & Prozess', key: 'DEBUG',
    label: 'Ausführliches Logging (Server)', type: 'boolean',
    onValue: '1', offValue: '0', def: '0', applyMode: 'restart',
    desc: 'Schaltet detaillierte debug()-Logausgaben im Server frei. Der DEBUG-Flag '
      + 'wird als Modul-Konstante beim Import gesetzt (logger.js) — daher erst nach '
      + 'Neustart wirksam.',
  },

  // ======================= SERVER: Finalize / Speicherung ===================
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'FINALIZE_UPLOAD_DIR',
    label: 'Upload-Verzeichnis (transiente WAVs)', type: 'string', def: './uploads',
    applyMode: 'next-finalize',
    desc: 'Verzeichnis, in das der Bot die Session-WAVs vor dem Finalize hochlädt '
      + '(je Session ein Unterordner <sessionId>/ inkl. manifest.json). Wird pro '
      + 'Finalize-Vorgang neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'ARCHIVE_DIR',
    label: 'Langzeit-Archiv-Verzeichnis', type: 'string', def: './archive',
    applyMode: 'next-finalize',
    desc: 'Zielverzeichnis des permanenten Archivs (Transkript + Audio + JSONL + '
      + 'Manifest + Speaker-Map-Snapshot pro Session). Quelle für Re-Finalize. Wird '
      + 'nach jedem erfolgreichen Finalize zusätzlich automatisch vom Bot auf den '
      + 'Bot-Host gezogen (siehe BOT_ARCHIVE_DIR) — überlebt so das Zerstören der '
      + 'ephemeren Cloud-Instanz. Wird beim Finalize gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'TRANSCRIPT_DIR',
    label: 'Transkript-Verzeichnis (Live-JSONL)', type: 'string', def: './transcripts',
    applyMode: 'live',
    desc: 'Verzeichnis für die fortlaufenden Live-Transkript-Events (JSONL pro '
      + 'Session), die die Transkript-UI und das spätere Finalize nutzen. Jedes '
      + 'Event wird zusätzlich live über die Control-WS an den Bot gepusht und dort '
      + 'in BOT_TRANSCRIPT_DIR gespiegelt — übersteht so auch das Ende der '
      + '(bei Cloud-Instanzen: ephemeren) Server-Kopie. Wird pro Zugriff neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SPEAKER_MAP_FILE',
    label: 'Speaker-Map-Datei', type: 'string', def: './data/speaker-map.json',
    applyMode: 'live',
    desc: 'Pfad zur persistenten Sprecher-Zuordnung (Discord-ID → Spieler/Charakter/'
      + 'phonetische Schreibweise), pro Guild. Diese Datei bearbeitest du im '
      + 'Speaker-Map-Tab. Wird pro Zugriff neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'PAUSE_THRESHOLD_S',
    label: 'Pausen-Schwellwert im Transkript (s)', type: 'number', def: '30',
    applyMode: 'next-finalize',
    desc: 'Ab dieser Stille-Dauer (Sekunden) fügt das Finalize eine Pausen-Markierung '
      + '"## HH:MM — Pause (N min)" ins Transkript ein. Wird beim Finalize gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'FINALIZE_TZ',
    label: 'Zeitzone für Transkript-Zeitstempel', type: 'string', def: 'Europe/Berlin',
    applyMode: 'next-finalize',
    desc: 'IANA-Zeitzone für die Uhrzeiten im finalisierten Transkript '
      + '(z. B. Europe/Berlin). Wird beim Finalize gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'ARCHIVE_AUDIO_FORMAT',
    label: 'Archiv-Audioformat (pro Äußerung)', type: 'enum', enumValues: ['wav', 'ogg'],
    def: 'wav', applyMode: 'next-finalize',
    desc: 'Format der einzelnen Äußerungs-Audios im Archiv. wav = verlustfreie '
      + 'Original-WAVs (Standard, ermöglicht Re-Finalize). ogg = platzsparend als '
      + 'Opus encodieren (Re-Finalize aus dem Archiv erst mit OGG→PCM-Decode möglich). '
      + 'Der gemergte session_mix.ogg entsteht unabhängig davon. Wird beim Finalize gelesen.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'ARCHIVE_OPUS_BITRATE',
    label: 'Opus-Bitrate fürs Archiv', type: 'string', def: '32k', applyMode: 'restart',
    desc: 'Bitrate für die Opus/OGG-Encodierung im Archiv (z. B. 32k, 48k). Wird als '
      + 'Modul-Konstante beim Import gesetzt (archive.js) — daher erst nach Neustart wirksam.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'FINALIZE_KEEP_UPLOADS',
    label: 'Transiente Uploads nach Finalize behalten', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'false', applyMode: 'next-finalize',
    desc: 'false = die hochgeladenen WAVs nach erfolgreicher Archivierung löschen '
      + '(Standard; das Archiv hält die Originale). true = zusätzlich im Upload-Ordner '
      + 'behalten. Wird beim Finalize gelesen.',
  },

  // ======================= SERVER: STT (Whisper) ============================
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'WHISPER_URL',
    label: 'Whisper-Server-URL', type: 'string', def: 'http://localhost:8080',
    applyMode: 'live',
    desc: 'Basis-URL des whisper.cpp-Servers, an den Audio zur Transkription gesendet '
      + 'wird. Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'WHISPER_LANGUAGE',
    label: 'Erkennungssprache', type: 'enum', enumValues: ['de', 'en', 'auto'],
    def: 'de', applyMode: 'live',
    desc: 'Sprachcode für die Spracherkennung. de/en erzwingen die Sprache, auto lässt '
      + 'Whisper raten. Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'WHISPER_TEMPERATURE',
    label: 'STT-Sampling-Temperatur', type: 'number', def: '0.1', applyMode: 'live',
    desc: 'Sampling-Temperatur der Erkennung. Werte > 0 liefern deutlich brauchbarere '
      + 'no_speech_prob-Werte; 0.1 ist ein konservativer, auf de_DE getesteter Default. '
      + 'Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_MAX_CHUNK_SECONDS',
    label: 'Max. Chunk-Länge (s)', type: 'number', def: '30', applyMode: 'live',
    desc: 'Maximale Länge eines STT-Chunks, bevor an einer Stille gesplittet oder '
      + 'erzwungen geteilt wird. Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'WHISPER_WORD_TIMESTAMPS',
    label: 'Wort-Zeitstempel anfordern', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = wortgenaue Zeitstempel von Whisper anfordern (für präzises '
      + 'Interrupt-Splitting im Finalize). Wird ignoriert, wenn der Whisper-Server das '
      + 'nicht kann. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_STREAMING',
    label: 'Streaming-Transkription während des Sprechens', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = echtes Wort-Streaming: das wachsende Audio-Fenster wird laufend als '
      + 'Ganzes transkribiert (LocalAgreement) — stabile Wörter erscheinen sofort im '
      + 'Transkript, der Satzrest als noch korrigierbare Vorschau. Keine Chunk-Grenzen '
      + 'im Live-Pfad. Das finale Ergebnis (Weckwort/LLM) entsteht weiterhin am '
      + 'Äußerungsende und ersetzt die Vorschau. Wird pro Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_STREAM_INTERVAL_MS',
    label: 'Streaming-Tick-Intervall (ms)', type: 'number', def: '1000',
    applyMode: 'restart',
    desc: 'Wie oft das aktive Fenster eines Sprechers neu transkribiert wird. Kleiner = '
      + 'reaktiveres Live-Transkript, aber mehr GPU-Last (jede Transkription kostet je '
      + 'nach Fensterlänge ~0,5–2 s auf der RX 6800 XT). Wird beim Start des '
      + 'Streaming-Loops einmalig gelesen (Neustart nötig).',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_STREAM_MIN_WINDOW_MS',
    label: 'Streaming: Mindest-Audio vor erstem Tick (ms)', type: 'number', def: '1000',
    applyMode: 'live',
    desc: 'So viel Audio muss vorliegen, bevor der Streamer das Fenster zum ersten Mal '
      + 'transkribiert. Sehr kleine Fenster liefern unbrauchbare Hypothesen. Wird pro '
      + 'Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_STREAM_TRIM_SECONDS',
    label: 'Streaming: Fenster-Trim ab (s)', type: 'number', def: '15', applyMode: 'live',
    desc: 'Sobald die bestätigten Wörter so viele Sekunden Audio abdecken, wird das '
      + 'Fenster an der letzten bestätigten Satzgrenze abgeschnitten und der Text '
      + 'fixiert. Hält die pro Tick transkribierte Fensterlänge (und damit die '
      + 'GPU-Last) unabhängig von der Länge des Monologs. Wird pro Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_STREAM_PROMPT',
    label: 'Streaming: fixierten Text als Kontext mitgeben', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = bereits fixierter Text wird Whisper als Decoder-Prompt mitgegeben, '
      + 'damit die Erkennung über die Fenstergrenze hinweg konsistent bleibt '
      + '(Satzanfang bekannt). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'STT_SILENCE_THRESH',
    label: 'RMS-Schwellwert Stille-Erkennung', type: 'number', def: '300', applyMode: 'live',
    desc: 'RMS-Amplituden-Schwelle für die Stille-Erkennung beim Aufteilen langer '
      + 'Äußerungen. Höher = toleranter gegenüber Hintergrundgeräuschen. Wird in der '
      + 'Pipeline pro Verarbeitung gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT (Whisper.cpp)', key: 'WHISPER_NO_SPEECH_THRESHOLD',
    label: 'no_speech_prob-Schwellwert', type: 'number', def: '', applyMode: 'restart',
    note: 'Zukunftswert — derzeit im Code nicht aktiv ausgewertet (nur für Finalize/Offline-Tests vorgesehen).',
    desc: 'Optionaler Schwellwert, ab dem eine Äußerung als "keine Sprache" verworfen '
      + 'würde. Der Live-Pfad speichert no_speech_prob, verwirft aber nichts. Reserviert.',
  },

  // ======================= SERVER: LLM (Ollama) =============================
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'OLLAMA_URL',
    label: 'Ollama-Server-URL', type: 'string', def: 'http://localhost:11434',
    applyMode: 'live',
    desc: 'Basis-URL des Ollama-Dienstes, der die Antworten generiert. Wird pro '
      + 'LLM-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'OLLAMA_MODEL',
    label: 'Ollama-Modell', type: 'string', def: 'llama3.2', applyMode: 'live',
    desc: 'Name des Ollama-Modells für die Antwortgenerierung (z. B. llama3.2). '
      + 'Dient auch als Fallback für die Zusammenfassung, wenn SUMMARY_MODEL leer ist. '
      + 'Wird pro Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'SYSTEM_PROMPT_FILE',
    label: 'System-Prompt-Datei', type: 'string', def: './prompt.txt', applyMode: 'restart',
    desc: 'Pfad zu einer Textdatei mit dem System-Prompt (Persönlichkeit/Regeln des '
      + 'Assistenten), relativ zu apps/server. Wird EINMALIG beim Import geladen '
      + '(llm.js) — Änderung erst nach Neustart wirksam. Vorrang vor SYSTEM_PROMPT.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'SYSTEM_PROMPT',
    label: 'System-Prompt (inline)', type: 'string', def: '', applyMode: 'restart',
    desc: 'Alternative zu SYSTEM_PROMPT_FILE: der System-Prompt direkt als Text. Wird '
      + 'nur genutzt, wenn keine Datei gesetzt/lesbar ist, und ebenfalls einmalig beim '
      + 'Import geladen — Änderung erst nach Neustart wirksam.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'HISTORY_TURNS',
    label: 'Gesprächsrunden im Kontext', type: 'number', def: '6', applyMode: 'live',
    desc: 'Anzahl der vergangenen Frage/Antwort-Runden, die dem LLM als Verlauf '
      + 'mitgegeben werden. Höher = mehr Kontext, aber längere Prompts. Wird pro '
      + 'Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'OLLAMA_KEEP_ALIVE',
    label: 'Modell-Verweildauer im VRAM', type: 'string', def: '30m', applyMode: 'live',
    desc: 'Wie lange Ollama das Modell nach einer Anfrage im Speicher hält (z. B. 30m, '
      + '-1 = dauerhaft). Verhindert wiederholtes Nachladen. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'DISCORD_POST_REPLIES',
    label: 'Antwort in Discord-Chat schreiben', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'false', applyMode: 'live',
    desc: 'Ob die Antwort des Assistenten (und Stop-Hinweise) zusätzlich als Text in '
      + 'den Discord-Textkanal geschrieben werden. Standard: aus — Sprachausgabe + '
      + 'Transkript sind der primäre Ausgabeweg. true = Frage/Antwort erscheinen auch '
      + 'als Chat-Nachricht. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'OLLAMA_KEEP_WARM_INTERVAL_MS',
    label: 'Keep-Warm-Ping-Intervall (ms)', type: 'number', def: '240000',
    applyMode: 'next-session',
    desc: 'Intervall periodischer Keep-Warm-Pings an Ollama, solange der Bot im '
      + 'Voice-Channel ist (0 = keine periodischen Pings). Ein laufender Timer wird '
      + 'erst beim nächsten Start des Keep-Warm-Zyklus mit dem neuen Wert neu terminiert.',
  },

  // ======================= SERVER: Live- & Kampagnen-Kontext ================
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LIVE_CONTEXT_ENABLED',
    label: 'Live-Kontext aktiv', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'true', applyMode: 'live',
    desc: 'true = dem LLM werden Live-Transkript (alle Sprecher) + rollende '
      + 'Zusammenfassung + statischer Kampagnen-Kontext als System-Blöcke mitgegeben. '
      + 'false = altes Verhalten (nur HISTORY_TURNS-Verlauf). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LIVE_RAW_WINDOW_CHARS',
    label: 'Roh-Puffer-Zielgröße (Zeichen)', type: 'number', def: '6000', applyMode: 'live',
    desc: 'Zielgröße des rohen Live-Transkript-Puffers in Zeichen. Bei Überlauf werden '
      + 'die ältesten Turns in die Zusammenfassung "gefaltet". Wird pro Verarbeitung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LIVE_FOLD_CHARS',
    label: 'Faltungs-Menge (Zeichen)', type: 'number', def: '3000', applyMode: 'live',
    desc: 'Wie viele Zeichen pro Faltung (vom ältesten Ende) in die Zusammenfassung '
      + 'überführt werden. Wird bei der Faltung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LIVE_RENDER_MAX_CHARS',
    label: 'Live-Transkript im Prompt (max. Zeichen)', type: 'number', def: '6000',
    applyMode: 'live',
    desc: 'Obergrenze, wie viele Zeichen das gerenderte Live-Transkript im LLM-Prompt '
      + 'belegen darf. Wird beim Bauen des Prompts gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LIVE_FOLD_MIN_INTERVAL_MS',
    label: 'Mindestabstand zwischen Faltungen (ms)', type: 'number', def: '0', applyMode: 'live',
    desc: 'Drosselung: minimaler Zeitabstand zwischen zwei Faltungen (0 = keine '
      + 'Drosselung). Verhindert zu häufiges Zusammenfassen. Wird bei der Faltung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'SUMMARY_MODEL',
    label: 'Modell für Zusammenfassung', type: 'string', def: '', applyMode: 'live',
    desc: 'Separates Ollama-Modell für die rollende Zusammenfassung. Leer = OLLAMA_MODEL '
      + 'verwenden. Wird pro Zusammenfassung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'SUMMARY_MAX_CHARS',
    label: 'Max. Länge Zusammenfassung (Zeichen)', type: 'number', def: '2000', applyMode: 'live',
    desc: 'Obergrenze der Zeichenzahl der rollenden Zusammenfassung. Wird bei der '
      + 'Zusammenfassung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'OBSIDIAN_VAULT_PATH',
    label: 'Obsidian-Vault-Wurzel', type: 'string', def: '', applyMode: 'live',
    desc: 'Wurzelverzeichnis des Obsidian-Vaults. Nötig, wenn CAMPAIGN_CONTEXT_FILE ein '
      + 'relativer Pfad ist. Relativ ohne gesetzten Vault → Kampagnen-Kontext deaktiviert. '
      + 'Wird beim Laden des Kontexts gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'CAMPAIGN_CONTEXT_FILE',
    label: 'Kampagnen-Kontext-Datei', type: 'string', def: 'CAMPAIGN.md', applyMode: 'live',
    desc: 'Datei mit dem statischen Kampagnen-Kontext (Weltinfos, NSCs …). Absoluter Pfad '
      + 'oder relativ zu OBSIDIAN_VAULT_PATH. Wird dem LLM als System-Block vorangestellt. '
      + 'Wird beim Laden des Kontexts gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'CAMPAIGN_CONTEXT_MAX_CHARS',
    label: 'Max. Zeichen Kampagnen-Kontext', type: 'number', def: '6000', applyMode: 'live',
    desc: 'Obergrenze der Zeichen (vom Dateianfang), die aus der Kampagnen-Kontext-Datei '
      + 'übernommen werden. Gilt genauso für die RAG-Treffer pro Wake-Word-Query und für '
      + 'den Vault-Kontext des /join-Briefings (beste Treffer zuerst). Wird beim Laden gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_URL',
    label: 'RAG-Dienst-URL (semantische Vault-Suche)', type: 'string', def: '',
    applyMode: 'live',
    desc: 'Basis-URL des Python-RAG-Dienstes (apps/rag). Gesetzt → pro Wake-Word-Query '
      + 'semantische Suche im Obsidian-Vault statt statischem CAMPAIGN.md; bei Fehler/'
      + 'Timeout Fallback auf die Datei. Leer = RAG aus. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_TIMEOUT_MS',
    label: 'RAG-Timeout (ms)', type: 'number', def: '800', applyMode: 'live',
    desc: 'Timeout pro RAG-Abfrage in ms (Verbindung + Antwort); danach Fallback auf '
      + 'CAMPAIGN.md, die Voice-Pipeline wartet also höchstens so lange auf RAG. Das '
      + '/join-Briefing läuft abseits der Pipeline und bekommt mindestens 5000 ms. Wird '
      + 'pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_BRIEFING_ENABLED',
    label: 'Session-Briefing beim /join', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'true', applyMode: 'next-session',
    desc: 'Session-Briefing beim /join (einmal pro Session) — RAG-Query mit der aus dem '
      + 'Transkript-JSONL dieser Session rekonstruierten rollenden Zusammenfassung, Ergebnis '
      + 'als system-Message an den Anfang der conversationHistory. Greift damit nur beim '
      + 'Fortsetzen einer Session mit bereits zusammengefasstem Verlauf (z. B. nach '
      + 'Server-Neustart); eine neue Session hat noch keine Zusammenfassung. Nur wirksam '
      + 'wenn RAG_URL gesetzt. Wird beim Session-Start gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_BRIEFING_TOP_K',
    label: 'Vault-Chunks fürs Briefing', type: 'number', def: '3', applyMode: 'next-session',
    desc: 'Anzahl Vault-Chunks fürs /join-Briefing (1–20, mehr lehnt der RAG-Dienst ab; '
      + 'wird gekappt). Wird beim Session-Start gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_BRIEFING_POST_CHAT',
    label: 'Briefing als Chat-Nachricht posten', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'false', applyMode: 'next-session',
    desc: 'Briefing zusätzlich als kurze Discord-Textnachricht in den Join-Kanal posten '
      + '(LLM-generierter 2-3-Satz-Text). false = nur als LLM-Kontext injizieren. Wird '
      + 'beim Session-Start gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'RAG_SCORE_THRESHOLD',
    label: 'Max. Trefferdistanz (Score-Filter)', type: 'number', def: '', applyMode: 'live',
    desc: 'Maximale Cosine-Distanz (0–2, kleiner = ähnlicher) für RAG-Treffer; wird als '
      + 'score_threshold im POST /query an den RAG-Dienst durchgereicht, der Treffer '
      + 'darüber verwirft, bevor sie in den LLM-Kontext gehen. Leer = kein Filter (alle '
      + 'Top-K-Treffer). Typisch sinnvoll ~0.6–0.9. Wird pro Anfrage gelesen.',
  },

  // ======================= SERVER: TTS ======================================
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_PROVIDER',
    label: 'TTS-Anbieter', type: 'enum', enumValues: ['piper', 'elevenlabs'], def: 'piper',
    applyMode: 'live',
    desc: 'Sprachsynthese-Backend. piper = lokaler Piper-Server (Standard). elevenlabs = '
      + 'Cloud-Stimmen (benötigt ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID). Wird pro '
      + 'TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_URL',
    label: 'Piper-Server-URL', type: 'string', def: 'http://localhost:5000', applyMode: 'live',
    desc: 'Basis-URL des lokalen Piper-TTS-Servers (bei TTS_PROVIDER=piper). Wird pro '
      + 'TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs API-Key', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'API-Schlüssel für ElevenLabs (bei TTS_PROVIDER=elevenlabs). Secret — hier nur '
      + 'Status sichtbar; Änderung über .env. Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'ELEVENLABS_VOICE_ID',
    label: 'ElevenLabs Voice-ID', type: 'string', def: 'EXAVITQu4vr4xnSDxMaL', applyMode: 'live',
    desc: 'ID der ElevenLabs-Stimme (bei TTS_PROVIDER=elevenlabs). Keine geheime Angabe. '
      + 'Wird pro TTS-Anfrage gelesen.',
  },

  // ======================= SERVER: Wake- / Stop-Word ========================
  {
    scope: 'server', group: 'Server · Wake- & Stop-Word', key: 'WAKE_WORD',
    label: 'Weckwort', type: 'string', def: 'Rabenauge', applyMode: 'live',
    desc: 'Wort, das eine Äußerung an den Assistenten richtet. Wird pro Äußerung in der '
      + 'Pipeline geprüft — Änderung sofort aktiv.',
  },
  {
    scope: 'server', group: 'Server · Wake- & Stop-Word', key: 'WAKE_WORD_FUZZY',
    label: 'Unscharfe Weckwort-Erkennung', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'true', applyMode: 'live',
    desc: 'true = Weckwort auch bei kleinen Erkennungsfehlern akzeptieren '
      + '(Levenshtein-Distanz ≤ 2). Wird pro Äußerung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Wake- & Stop-Word', key: 'WAKE_WORD_POSITION',
    label: 'Max. Weckwort-Position im Satz', type: 'number', def: '3', applyMode: 'live',
    desc: 'Bis zur wievielten Position im Satz das Weckwort stehen darf (0 = überall, '
      + '3 = nur in den ersten 3 Wörtern). Wird pro Äußerung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Wake- & Stop-Word', key: 'STOP_PHRASES',
    label: 'Stop-Phrasen', type: 'list',
    def: 'stop,stopp,abbrechen,beenden,hör auf,aufhören,halt,halte an,halte ein',
    applyMode: 'live',
    desc: 'Kommagetrennte Phrasen, die eine laufende TTS-Wiedergabe abbrechen. Ohne '
      + 'Weckwort nur bei kurzen Äußerungen aktiv (siehe STOP_WITHOUT_WAKE_MAX_WORDS). '
      + 'Wird pro Äußerung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Wake- & Stop-Word', key: 'STOP_WITHOUT_WAKE_MAX_WORDS',
    label: 'Stop ohne Weckwort — max. Wörter', type: 'number', def: '5', applyMode: 'live',
    desc: 'Nur wenn eine Äußerung höchstens so viele Wörter hat, zählt eine Stop-Phrase '
      + 'ohne vorangestelltes Weckwort. Verhindert versehentliche Abbrüche in langen '
      + 'Sätzen. Wird pro Äußerung gelesen.',
  },

  // ======================= SERVER: Transkript-UI-Auth =======================
  {
    scope: 'server', group: 'Server · Transkript-UI-Zugang', key: 'TRANSCRIPT_UI_AUTH',
    label: 'Auth-Modus der Transkript-UI', type: 'enum', enumValues: ['basic', 'off'],
    def: 'basic', applyMode: 'restart',
    desc: 'basic = HTTP-Basic-Auth vor der Transkript-UI (und diesem Panel). off = offener '
      + 'Zugang (nur im vertrauten LAN sinnvoll). An/Aus wird bei der Routen-Registrierung '
      + 'entschieden — Umschalten erst nach Neustart wirksam.',
  },
  {
    scope: 'server', group: 'Server · Transkript-UI-Zugang', key: 'TRANSCRIPT_UI_USER',
    label: 'UI-Benutzername', type: 'string', def: 'greyhawk', applyMode: 'live',
    desc: 'Benutzername für die Basic-Auth der Transkript-UI/dieses Panels. Wird pro '
      + 'Request geprüft — Änderung sofort aktiv (danach neu einloggen).',
  },
  {
    scope: 'server', group: 'Server · Transkript-UI-Zugang', key: 'TRANSCRIPT_UI_PASS',
    label: 'UI-Passwort', type: 'string', def: 'greyhawk', applyMode: 'live',
    secret: true, editable: false,
    desc: 'Passwort für die Basic-Auth. Secret — hier nur Status sichtbar. Änderung über '
      + '.env bzw. gezielt serverseitig; wird pro Request geprüft.',
  },

  // ======================= SERVER: Playout-Annonce ==========================
  {
    scope: 'server', group: 'Server · Playout-Annonce (Server→Bot)', key: 'JITTER_MS',
    label: 'Jitter-Puffer (ms, annonciert)', type: 'number', def: '120', applyMode: 'next-session',
    desc: 'Vom Server an den Bot annoncierter Jitter-Puffer für die Wiedergabe. Wird in '
      + 'serverParams() bei Session-Start an den Bot übermittelt; der Bot kann eigene '
      + 'lokale Werte verwenden. Greift ab der nächsten Session.',
  },
  {
    scope: 'server', group: 'Server · Playout-Annonce (Server→Bot)', key: 'PLAYOUT_MS',
    label: 'Playout-Vorlauf (ms, annonciert)', type: 'number', def: '200', applyMode: 'next-session',
    desc: 'Vom Server annoncierter Playout-Vorlauf. Wird bei Session-Start an den Bot '
      + 'übermittelt. Greift ab der nächsten Session.',
  },

  // ======================= BOT: Discord / Prozess ===========================
  {
    scope: 'bot', group: 'Bot · Discord & Prozess', key: 'DISCORD_TOKEN',
    label: 'Discord-Bot-Token', type: 'string', def: '', applyMode: 'restart',
    secret: true, editable: false,
    desc: 'Login-Token des Discord-Bots. Secret — hier nur Status sichtbar. Wird beim '
      + 'Bot-Start für client.login() benötigt; Änderung nur über die Bot-.env + Neustart.',
  },
  {
    scope: 'bot', group: 'Bot · Discord & Prozess', key: 'GUILD_IDS',
    label: 'Guild-IDs (Slash-Command-Ziele)', type: 'list', def: '', applyMode: 'restart',
    desc: 'Kommagetrennte Discord-Server-(Guild-)IDs, für die die Slash-Commands '
      + 'registriert werden (empfohlen für schnelle Propagation). Wird beim Bot-Start '
      + 'gelesen — greift nach Bot-Neustart.',
  },
  {
    scope: 'bot', group: 'Bot · Discord & Prozess', key: 'GUILD_ID',
    label: 'Guild-ID (Legacy, einzeln)', type: 'string', def: '', applyMode: 'restart',
    note: 'Legacy-Fallback: nur genutzt, wenn GUILD_IDS leer ist.',
    desc: 'Einzelne Guild-ID als Rückfall-Option, wenn GUILD_IDS nicht gesetzt ist. Wird '
      + 'beim Bot-Start gelesen — greift nach Bot-Neustart.',
  },
  {
    scope: 'bot', group: 'Bot · Discord & Prozess', key: 'DEBUG',
    label: 'Ausführliches Logging (Bot)', type: 'boolean', onValue: '1', offValue: '0',
    def: '0', applyMode: 'restart',
    desc: 'Schaltet detaillierte debug()-Logs im Bot frei. Wird als Modul-Konstante beim '
      + 'Import gesetzt — greift nach Bot-Neustart.',
  },

  // ======================= BOT: Server-Verbindung ===========================
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'SERVER_BASE_URL',
    label: 'Server-Basis-URL', type: 'string', def: 'ws://192.168.x.x:7440',
    applyMode: 'reconnect',
    desc: 'ws:// oder wss:// Basis-URL des LAN-Servers. Der Bot verbindet sich hierüber '
      + 'zu /control, /uplink, /downlink. Wird beim Verbindungsaufbau gelesen — greift '
      + 'beim nächsten Reconnect.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'CONTROL_WS_URL',
    label: 'Control-WS-URL (Alternative)', type: 'string', def: '', applyMode: 'reconnect',
    note: 'Alternative zu SERVER_BASE_URL; nur nötig, wenn der Control-Endpunkt separat liegt.',
    desc: 'Explizite WebSocket-URL des Control-Kanals, falls sie nicht aus SERVER_BASE_URL '
      + 'abgeleitet werden soll. Wird beim Verbindungsaufbau gelesen — greift beim Reconnect.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'CONTROL_BEARER',
    label: 'Control-Bearer (Bot-Seite)', type: 'string', def: '', applyMode: 'reconnect',
    secret: true, editable: false,
    desc: 'Muss mit dem CONTROL_BEARER des Servers übereinstimmen. Secret — hier nur '
      + 'Status sichtbar. Wird beim Verbindungsaufbau gelesen.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'SERVER_START_CMD',
    label: 'Server-Autostart-Kommando', type: 'string', def: '', applyMode: 'live',
    desc: 'Optionales Shell-Kommando (z. B. SSH), das der Bot beim /join ausführt, wenn '
      + 'der Server per TCP-Probe nicht erreichbar ist, um ihn zu starten. Wird pro /join '
      + 'gelesen — Änderung sofort aktiv.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'SERVER_START_TIMEOUT_MS',
    label: 'Server-Autostart: Wartezeit auf Erreichbarkeit (ms)', type: 'number',
    def: '300000', applyMode: 'live',
    desc: 'Wie lange (ms) nach SERVER_START_CMD auf TCP-Erreichbarkeit des Servers '
      + 'gewartet wird, bevor der Start als fehlgeschlagen gilt. Cloud-Kaltstarts '
      + '(Instanz-Provisionierung + Image-Pull) dauern deutlich länger als ein lokaler '
      + 'Start (Code-Fallback ohne Wert: 30000). Wird pro /join gelesen — sofort aktiv.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'SERVER_STOP_CMD',
    label: 'Server-Auto-Stop-Kommando', type: 'string', def: '', applyMode: 'live',
    desc: 'Optionales Shell-Kommando (z. B. SSH), das der Bot nach einer Leerlaufzeit '
      + 'ohne aktive Session ausführt, um den Cloud-GPU-Server herunterzufahren bzw. die '
      + 'Instanz zu zerstören (Verda-Abrechnung endet). Gegenstück zu SERVER_START_CMD. '
      + 'Ein /join und der Beginn eines Finalize brechen einen anstehenden Stopp ab. '
      + 'Leer = aus. Wird beim Planen des Stopps gelesen — Änderung sofort aktiv.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'SERVER_STOP_DELAY_MS',
    label: 'Server-Auto-Stop: Leerlaufzeit (ms)', type: 'number', def: '900000',
    applyMode: 'live',
    desc: 'Leerlaufzeit (ms) ohne aktive Session, nach der SERVER_STOP_CMD ausgeführt '
      + 'wird. Beim Ablauf wird erneut geprüft, ob wieder eine Session läuft — nur bei '
      + 'weiterhin Leerlauf wird gestoppt. Default 900000 (15 Minuten). Wird beim Planen '
      + 'des Stopps gelesen — Änderung sofort aktiv.',
  },

  // ======================= BOT: Daten & Session =============================
  {
    scope: 'bot', group: 'Bot · Daten & Session', key: 'DATA_DIR',
    label: 'Aufnahme-Datenverzeichnis', type: 'string', def: '/opt/discord-recorder/data',
    applyMode: 'restart',
    desc: 'Verzeichnis für Session-Aufnahmen (WAV/OGG/JSON) auf dem Bot-Host. Wird als '
      + 'Modul-Konstante beim Bot-Start gelesen — greift nach Bot-Neustart. (Auch Speicherort '
      + 'des Bot-Override-Layers.)',
  },
  {
    scope: 'bot', group: 'Bot · Daten & Session', key: 'SESSION_IDLE_HOURS',
    label: 'Session-Timeout (Stunden)', type: 'number', def: '4', applyMode: 'restart',
    desc: 'Stunden, nach denen eine inaktive Session automatisch beendet wird. Wird als '
      + 'Modul-Konstante beim Bot-Start gelesen — greift nach Bot-Neustart.',
  },

  // ======================= BOT: Transkript-Live-Sync =========================
  {
    scope: 'bot', group: 'Bot · Transkript-Live-Sync', key: 'BOT_TRANSCRIPT_DIR',
    label: 'Transkript-Sync-Verzeichnis (Bot-Host)', type: 'string', def: '~/transcripts',
    applyMode: 'restart',
    desc: 'Zielverzeichnis auf dem (persistenten) Bot-Host, in das der Server jedes '
      + 'Live-Transkript-Event (STT, LLM-Antwort, Wake-Word, …) zusätzlich zu seiner '
      + 'eigenen — bei Cloud-Instanzen: ephemeren — Kopie live über die Control-WS '
      + 'pusht (session_<id>.jsonl je Session). Unabhängig vom serverseitigen '
      + 'TRANSCRIPT_DIR. Wird als Modul-Konstante beim Bot-Start gelesen — greift '
      + 'erst nach einem Bot-Neustart, auch wenn eine Änderung hier sofort '
      + 'gespeichert wird.',
  },
  {
    scope: 'bot', group: 'Bot · Transkript-Live-Sync', key: 'BOT_TRANSCRIPT_RETENTION_DAYS',
    label: 'Aufbewahrung Transkript-Sync (Tage)', type: 'number', def: '30',
    applyMode: 'restart',
    desc: 'Wie viele Tage synchronisierte session_*.jsonl-Dateien in BOT_TRANSCRIPT_DIR '
      + 'aufbewahrt werden, bevor sie automatisch gelöscht werden (Prüfung täglich, '
      + 'einmal sofort beim Bot-Start). Wird als Modul-Konstante beim Bot-Start '
      + 'gelesen — greift erst nach einem Bot-Neustart.',
  },

  // ======================= BOT: Finalize-Archiv-Pull ==========================
  {
    scope: 'bot', group: 'Bot · Finalize-Archiv-Pull', key: 'BOT_ARCHIVE_DIR',
    label: 'Archiv-Zielverzeichnis (Bot-Host)', type: 'string', def: '~/archive',
    applyMode: 'restart',
    desc: 'Zielverzeichnis auf dem (persistenten) Bot-Host, in das der Bot das fertige '
      + 'Archiv (transcript.md, manifest.json, speaker-map.json, session.jsonl, '
      + 'audio/*) direkt nach einem erfolgreichen Finalize automatisch zurückzieht — '
      + 'sonst stirbt es mit der ephemeren Cloud-Instanz beim Auto-Stop. Jede Datei '
      + 'wird dabei per sha256 gegen das Server-Manifest verifiziert. Wird als '
      + 'Modul-Konstante beim Bot-Start gelesen — greift erst nach einem '
      + 'Bot-Neustart, auch wenn eine Änderung hier sofort gespeichert wird.',
  },
  {
    scope: 'bot', group: 'Bot · Finalize-Archiv-Pull', key: 'BOT_ARCHIVE_RETENTION_DAYS',
    label: 'Aufbewahrung gezogener Archive (Tage)', type: 'number', def: '60',
    applyMode: 'restart',
    desc: 'Wie viele Tage gepullte Archiv-Ordner in BOT_ARCHIVE_DIR aufbewahrt werden, '
      + 'bevor sie automatisch gelöscht werden (Prüfung täglich, einmal sofort beim '
      + 'Bot-Start). Wird als Modul-Konstante beim Bot-Start gelesen — greift erst '
      + 'nach einem Bot-Neustart.',
  },

  // ======================= BOT: Finalize-Upload =============================
  {
    scope: 'bot', group: 'Bot · Finalize-Upload', key: 'FINALIZE_UPLOAD_CMD',
    label: 'Upload-Kommando (WAV→Server, Legacy)', type: 'string', def: '', applyMode: 'live',
    desc: 'Kommando-Template (scp/SSH), mit dem der Bot die Session-WAVs zum Server '
      + 'überträgt. Platzhalter: {src} = lokales chunks-Verzeichnis, {sessionId} = '
      + 'Session-ID. LEER (neuer Default) = HTTP-Upload über die bestehende '
      + 'Server-Verbindung (SERVER_BASE_URL + CONTROL_BEARER, PUT /finalize/upload/…) '
      + '— der Cloud-Pfad ohne scp-Ziel (Instanz nur per WireGuard erreichbar). '
      + 'GESETZT = dieses Legacy-Kommando unverändert (LAN/Windows-Profil). Ist '
      + 'weder dieses Kommando noch SERVER_BASE_URL gesetzt, wird der Upload '
      + 'übersprungen (gemeinsames Dateisystem). Wird pro Finalize gelesen.',
  },
  {
    scope: 'bot', group: 'Bot · Finalize-Upload', key: 'ARCHIVE_RETENTION',
    label: 'Lokale WAVs nach Finalize', type: 'enum', enumValues: ['move', 'delete'],
    def: 'move', applyMode: 'live',
    desc: 'Was nach erfolgreichem (checksum-bestätigtem) Finalize mit den lokalen WAVs '
      + 'des Bots passiert: move = in _archived/ verschieben, delete = löschen. Wird pro '
      + 'Finalize gelesen.',
  },

  // ======================= BOT: TTS-Playback / Unterbrechung ================
  {
    scope: 'bot', group: 'Bot · TTS-Playback & Unterbrechung', key: 'GATE_MS',
    label: 'Gate-Zeit (ms)', type: 'number', def: '80', applyMode: 'reconnect',
    note: 'Legacy: im neuen FIFO-TTS-Pfad derzeit ungenutzt.',
    desc: 'Historischer Gating-Parameter der Wiedergabe. Wird beim Verbindungsaufbau in '
      + 'die Bot-Transport-Config übernommen. Im aktuellen FIFO-TTS-Pfad ohne Wirkung.',
  },
  {
    scope: 'bot', group: 'Bot · TTS-Playback & Unterbrechung', key: 'PLAYOUT_MAX_MS',
    label: 'Max. Playout (ms)', type: 'number', def: '1500', applyMode: 'reconnect',
    note: 'Legacy: im neuen FIFO-TTS-Pfad derzeit ungenutzt.',
    desc: 'Historische Playout-Obergrenze. Wird beim Verbindungsaufbau übernommen, im '
      + 'aktuellen FIFO-TTS-Pfad ohne Wirkung.',
  },
  {
    scope: 'bot', group: 'Bot · TTS-Playback & Unterbrechung', key: 'INTERRUPT_MIN_MS',
    label: 'Min. Sprechdauer für Unterbrechung (ms)', type: 'number', def: '800',
    applyMode: 'reconnect',
    desc: 'Wie lange ein Nutzer mindestens sprechen muss, damit eine laufende TTS-Ausgabe '
      + 'als unterbrochen gilt. Verhindert Abbrüche durch kurze Einwürfe/Husten. Wird beim '
      + 'Reconnect in die Transport-Config übernommen.',
  },
  {
    scope: 'bot', group: 'Bot · TTS-Playback & Unterbrechung', key: 'RESUME_GATE_MS',
    label: 'Wartezeit vor Fortsetzung (ms)', type: 'number', def: '1200', applyMode: 'reconnect',
    desc: 'Pause nach einer Unterbrechung, bevor die Wiedergabe fortgesetzt wird. Wird '
      + 'beim Reconnect übernommen.',
  },
  {
    scope: 'bot', group: 'Bot · TTS-Playback & Unterbrechung', key: 'REWIND_MS',
    label: 'Rücksprung beim Fortsetzen (ms)', type: 'number', def: '1000', applyMode: 'reconnect',
    desc: 'Wie weit vor der Unterbrechungsstelle die Wiedergabe beim Fortsetzen erneut '
      + 'einsetzt (Wiederholung für Verständlichkeit). Wird beim Reconnect übernommen.',
  },
];

// Schnell-Index key+scope → Eintrag (Keys wie DEBUG/CONTROL_BEARER existieren
// in beiden Scopes, daher ist scope Teil des Schlüssels).
const _index = new Map(CATALOG.map((e) => [`${e.scope}:${e.key}`, e]));
export function catalogEntry(scope, key) { return _index.get(`${scope}:${key}`); }

// Alle bot-seitig gültigen Keys (für die Validierung beim Push zum Bot).
export const BOT_KEYS = new Set(CATALOG.filter((e) => e.scope === 'bot').map((e) => e.key));
