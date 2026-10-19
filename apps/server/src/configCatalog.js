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

// Adressen, an die der Server ein Secret schickt (STT_/LLM_/EMBED_/TTS_/
// SUMMARY_/ELEVENLABS_BASE_URL), sind ebenfalls nur per .env änderbar
// (editable: false): sonst könnte, wer das Panel bedienen darf, die URL auf
// einen eigenen Server umbiegen und den Key abgreifen. Persistierte Overrides
// solcher Keys ignoriert der Server beim Boot (configStore.applyServerOverrides).
// Gleiche Regel wie beim Bot (SERVER_BASE_URL/CONTROL_WS_URL ← CONTROL_BEARER).
export function isSecretKey(key) {
  const k = String(key || '');
  return SECRET_KEY_PATTERNS.some((re) => re.test(k));
}

// Effektiver Secret-Status eines Katalog-Eintrags (Flag ODER Blacklist).
export function isSecretEntry(entry) {
  return !!(entry && (entry.secret || isSecretKey(entry.key)));
}

// Nur per .env setzbar: Secrets und editable:false-Einträge.
export function isEnvOnlyEntry(entry) {
  return !!(entry && (isSecretEntry(entry) || entry.editable === false));
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
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SESSION_SUMMARY_ENABLED',
    label: 'Session-Zusammenfassung beim Finalize', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'next-finalize',
    desc: 'Erzeugt beim Finalize per LLM eine kurze Zusammenfassung der Session '
      + '(summary.md im Archiv). Daraus beantwortet Rabenauge auf Nachfrage „Was war '
      + 'letztes Mal?" — nie als Begrüßung. Lange Sessions werden abschnittsweise '
      + 'verdichtet; die Namen aus STT_VOCABULARY / STT_VOCABULARY_FILE gehen als '
      + 'korrekte Schreibweisen mit. Ein Fehler hier lässt den Finalize unberührt.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SESSION_SUMMARY_MAX_CHARS',
    label: 'Länge der Session-Zusammenfassung (Zeichen)', type: 'number', def: '2500',
    applyMode: 'next-finalize',
    desc: 'Obergrenze für die Zusammenfassung (gekürzt am Satzende).',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SESSION_SUMMARY_CHUNK_CHARS',
    label: 'Abschnittsgröße für lange Sessions (Zeichen)', type: 'number', def: '18000',
    applyMode: 'next-finalize',
    desc: 'Transkripte (Spielerzeilen ohne Zeitstempel und Markup) über dieser Länge '
      + 'werden in Abschnitte geteilt, einzeln verdichtet und dann zusammengeführt. '
      + '18000 Zeichen ≈ 5,6k Token (gemma4, gemessen) — passt samt Prompt und Antwort in '
      + 'ein 8k-Kontextfenster (num_ctx). Größer = weniger, längere LLM-Aufrufe (nur mit '
      + 'größerem Kontextfenster), kleiner = für Modelle mit kleinem Kontextfenster.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SESSION_SUMMARY_TIMEOUT_MS',
    label: 'Zeitbudget der Session-Zusammenfassung (ms)', type: 'number', def: '1800000',
    applyMode: 'next-finalize',
    desc: 'Obergrenze für die gesamte Zusammenfassung (alle Abschnitte + Zusammenführung). '
      + 'Sie läuft innerhalb des Finalize, auf dessen Ergebnis der Bot wartet (er wartet, '
      + 'solange Fortschritt kommt — jeder LLM-Aufruf meldet sich; Obergrenze FINALIZE_MAX_MS). '
      + 'Eine 3-h-Session braucht mit gemma4:12b auf einer RX 6800 XT ~5 min. Wird das Budget '
      + 'knapp, werden die bis dahin verdichteten Abschnitte zusammengeführt und die '
      + 'Zusammenfassung endet mit einem Hinweis, dass sie unvollständig ist.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'SESSION_SUMMARY_VAULT_DIR',
    label: 'Zusammenfassung zusätzlich in den Vault schreiben', type: 'string', def: '',
    applyMode: 'next-finalize',
    desc: 'Ordner relativ zu OBSIDIAN_VAULT_PATH (z. B. Rabenauge/Sessions), in den eine '
      + 'Kopie der Zusammenfassung als Notiz geschrieben wird — der Vault-Index nimmt sie '
      + 'dann auf. Leer = aus (Standard: nichts wird ungefragt in den Vault geschrieben). '
      + 'Pfade außerhalb des Vaults werden abgelehnt.',
  },
  {
    scope: 'server', group: 'Server · Finalize & Speicherung', key: 'FINALIZE_PROGRESS_MS',
    label: 'Finalize-Fortschritt: Mindestabstand (ms)', type: 'number', def: '3000',
    applyMode: 'next-finalize',
    desc: 'Wie oft der Server den Fortschritt (x/N Äußerungen) an den Bot meldet, der ihn '
      + 'als Statusnachricht in Discord aktualisiert. Phasenwechsel kommen immer sofort.',
  },

  // ======================= SERVER: STT ======================================
  {
    scope: 'server', group: 'Server · STT', key: 'STT_PROVIDER',
    label: 'STT-Anbieter', type: 'enum', enumValues: ['whispercpp', 'openai'],
    def: 'whispercpp', applyMode: 'live',
    desc: 'Spracherkennungs-Backend. whispercpp = whisper.cpp-Server über dessen '
      + 'eigenen /inference-Endpunkt (WHISPER_URL, Standard). openai = beliebiger '
      + 'OpenAI-kompatibler /audio/transcriptions-Endpunkt (STT_BASE_URL, STT_MODEL, '
      + 'STT_API_KEY) — z. B. vLLM mit Whisper oder Voxtral, AMD Lemonade, Speaches '
      + 'oder whisper.cpp mit --inference-path /v1/audio/transcriptions. Wird pro '
      + 'STT-Anfrage gelesen (der nächste Streaming-Tick nutzt schon den neuen Anbieter).',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_BASE_URL',
    label: 'OpenAI-kompatible STT-URL', type: 'string', def: '', applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt STT_API_KEY an diese Adresse.',
    desc: 'Basis-URL inkl. /v1 (z. B. http://localhost:8000/v1) — angehängt wird '
      + '/audio/transcriptions. Nur bei STT_PROVIDER=openai; leer = Fehler bei jeder '
      + 'STT-Anfrage. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_MODEL',
    label: 'STT-Modell (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    desc: 'Modellname im Feld "model" der Anfrage (z. B. openai/whisper-large-v3 oder '
      + 'mistralai/Voxtral-Mini-3B-2507 bei vLLM, whisper-1 bei OpenAI). Leer = Feld '
      + 'weglassen, der Server nimmt sein Standardmodell (vLLM: das geladene Modell; '
      + 'whisper.cpp ignoriert es ohnehin). Nur bei STT_PROVIDER=openai. Wird pro '
      + 'STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_API_KEY',
    label: 'STT API-Key (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'Optionaler Bearer-Token für den OpenAI-kompatiblen STT-Server (bei '
      + 'STT_PROVIDER=openai; lokale Server brauchen meist keinen). Secret — hier nur '
      + 'Status sichtbar; Änderung über .env. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_TIMEOUT_MS',
    label: 'STT-Timeout (ms)', type: 'number', def: '120000', applyMode: 'live',
    desc: 'Maximale Dauer einer STT-Anfrage inkl. Upload und Lesen der Antwort, für '
      + 'beide Anbieter. Danach schlägt die Anfrage mit "stt: timeout" fehl: ein '
      + 'Streaming-Tick wird übersprungen; scheitert der Abschluss-Durchlauf, fehlt die '
      + 'Äußerung im Live-Transkript (das Finalize transkribiert sie später erneut). '
      + '0 = kein Timeout. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'WHISPER_URL',
    label: 'Whisper-Server-URL', type: 'string', def: 'http://localhost:8080',
    applyMode: 'live',
    desc: 'Basis-URL des whisper.cpp-Servers, an den Audio zur Transkription gesendet '
      + 'wird (POST /inference; bei STT_PROVIDER=whispercpp). Wird pro STT-Anfrage '
      + 'neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_LANGUAGE',
    label: 'Erkennungssprache (anbieterneutral)', type: 'enum',
    enumValues: ['', 'de', 'en', 'auto'], def: '', applyMode: 'live',
    desc: 'Sprachcode für die Spracherkennung, gilt für beide Anbieter. de/en erzwingen '
      + 'die Sprache, auto lässt das Modell raten. Leer = WHISPER_LANGUAGE verwenden '
      + '(den lesen auch die Startskripte für den whisper.cpp-Server). Wird pro '
      + 'STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'WHISPER_LANGUAGE',
    label: 'Erkennungssprache', type: 'enum', enumValues: ['de', 'en', 'auto'],
    def: 'de', applyMode: 'live',
    desc: 'Sprachcode für die Spracherkennung. de/en erzwingen die Sprache, auto lässt '
      + 'Whisper raten. Wird verwendet, solange STT_LANGUAGE leer ist (gilt dann auch '
      + 'für STT_PROVIDER=openai). Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'WHISPER_TEMPERATURE',
    label: 'STT-Sampling-Temperatur', type: 'number', def: '0.1', applyMode: 'live',
    desc: 'Sampling-Temperatur der Erkennung (beide Anbieter). Werte > 0 liefern '
      + 'deutlich brauchbarere no_speech_prob-Werte; 0.1 ist ein konservativer, auf '
      + 'de_DE getesteter Default. Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_MAX_CHUNK_SECONDS',
    label: 'Max. Chunk-Länge (s)', type: 'number', def: '30', applyMode: 'live',
    desc: 'Maximale Länge eines STT-Chunks, bevor an einer Stille gesplittet oder '
      + 'erzwungen geteilt wird. Wird pro STT-Anfrage neu gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'WHISPER_WORD_TIMESTAMPS',
    label: 'Wort-Zeitstempel anfordern', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = wortgenaue Zeitstempel anfordern (für präzises Interrupt-Splitting im '
      + 'Finalize und stabile Wörter im Streaming; beide Anbieter). Wird ignoriert, wenn '
      + 'der STT-Server das nicht kann. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_STREAMING',
    label: 'Streaming-Transkription während des Sprechens', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = echtes Wort-Streaming: das wachsende Audio-Fenster wird laufend als '
      + 'Ganzes transkribiert (LocalAgreement) — stabile Wörter erscheinen sofort im '
      + 'Transkript, der Satzrest als noch korrigierbare Vorschau. Keine Chunk-Grenzen '
      + 'im Live-Pfad. Das finale Ergebnis (Weckwort/LLM) entsteht weiterhin am '
      + 'Äußerungsende und ersetzt die Vorschau. Wird pro Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_STREAM_INTERVAL_MS',
    label: 'Streaming-Tick-Intervall (ms)', type: 'number', def: '1000',
    applyMode: 'restart',
    desc: 'Wie oft das aktive Fenster eines Sprechers neu transkribiert wird. Kleiner = '
      + 'reaktiveres Live-Transkript, aber mehr GPU-Last (jede Transkription kostet je '
      + 'nach Fensterlänge ~0,5–2 s auf der RX 6800 XT). Wird beim Start des '
      + 'Streaming-Loops einmalig gelesen (Neustart nötig).',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_STREAM_MIN_WINDOW_MS',
    label: 'Streaming: Mindest-Audio vor erstem Tick (ms)', type: 'number', def: '1000',
    applyMode: 'live',
    desc: 'So viel Audio muss vorliegen, bevor der Streamer das Fenster zum ersten Mal '
      + 'transkribiert. Sehr kleine Fenster liefern unbrauchbare Hypothesen. Wird pro '
      + 'Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_STREAM_TRIM_SECONDS',
    label: 'Streaming: Fenster-Trim ab (s)', type: 'number', def: '15', applyMode: 'live',
    desc: 'Sobald die bestätigten Wörter so viele Sekunden Audio abdecken, wird das '
      + 'Fenster an der letzten bestätigten Satzgrenze abgeschnitten und der Text '
      + 'fixiert. Hält die pro Tick transkribierte Fensterlänge (und damit die '
      + 'GPU-Last) unabhängig von der Länge des Monologs. Wird pro Tick gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_STREAM_PROMPT',
    label: 'Streaming: fixierten Text als Kontext mitgeben', type: 'boolean',
    onValue: 'true', offValue: 'false', def: 'true', applyMode: 'live',
    desc: 'true = bereits fixierter Text wird Whisper als Decoder-Prompt mitgegeben, '
      + 'damit die Erkennung über die Fenstergrenze hinweg konsistent bleibt '
      + '(Satzanfang bekannt). Das Namen-Vokabular (STT_VOCABULARY) steht unabhängig '
      + 'davon immer vorne im Prompt. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_VOCABULARY',
    label: 'Namen-Vokabular für die Spracherkennung', type: 'string', def: '', applyMode: 'live',
    desc: 'Kommagetrennte Eigennamen der Kampagne (Charaktere, NSCs, Orte), z. B. '
      + '"Gaglath Matho, Rhogar Tonitruvales, Uhtred Ragnason, Greyhawk". Werden Whisper '
      + 'bei JEDER Transkription (Live-Streaming, Chunk-Fallback, Finalize) als Prompt '
      + 'vorangestellt, damit die Namen richtig geschrieben erkannt werden. Reihenfolge = '
      + 'Priorität: höchstens 250 Zeichen gehen in den Prompt (Whisper liest nur ~224 '
      + 'Prompt-Token), der Rest wird mit Warnung im Log weggelassen. Lange Listen erhöhen '
      + 'das Risiko, dass Whisper in Stille Namen halluziniert — Wirkung mit npm run '
      + 'bench:stt messen. Steht vor den Namen aus STT_VOCABULARY_FILE. Die Session-'
      + 'Zusammenfassung beim Finalize bekommt die Liste (bis 1500 Zeichen) als korrekte '
      + 'Schreibweisen. Leer = aus. Wird pro STT-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_VOCABULARY_FILE',
    label: 'Namen-Vokabular aus Datei', type: 'string', def: '', applyMode: 'live',
    desc: 'Datei mit Eigennamen für die Spracherkennung — absoluter Pfad oder relativ zu '
      + 'OBSIDIAN_VAULT_PATH (z. B. STT-Vokabular.md im Vault). Ein oder mehrere Namen pro '
      + 'Zeile (Komma/Semikolon trennt), # leitet einen Kommentar ein (Markdown-Überschriften '
      + 'werden also ignoriert), Listenzeichen, Frontmatter und [[Wikilinks]] werden entfernt. '
      + 'Kandidaten aus dem Vault liefert npm run vocab:stt — Liste prüfen, dann ablegen. '
      + 'Gleiches Budget wie STT_VOCABULARY (beide zusammen). Leer = aus. Wird pro '
      + 'STT-Anfrage gelesen (Änderungen an der Datei greifen sofort).',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'STT_SILENCE_THRESH',
    label: 'RMS-Schwellwert Stille-Erkennung', type: 'number', def: '300', applyMode: 'live',
    desc: 'RMS-Amplituden-Schwelle für die Stille-Erkennung beim Aufteilen langer '
      + 'Äußerungen. Höher = toleranter gegenüber Hintergrundgeräuschen. Wird in der '
      + 'Pipeline pro Verarbeitung gelesen.',
  },
  {
    scope: 'server', group: 'Server · STT', key: 'WHISPER_NO_SPEECH_THRESHOLD',
    label: 'no_speech_prob-Schwellwert', type: 'number', def: '', applyMode: 'restart',
    note: 'Zukunftswert — derzeit im Code nicht aktiv ausgewertet (nur für Finalize/Offline-Tests vorgesehen).',
    desc: 'Optionaler Schwellwert, ab dem eine Äußerung als "keine Sprache" verworfen '
      + 'würde. Der Live-Pfad speichert no_speech_prob, verwirft aber nichts. Reserviert.',
  },

  // ======================= SERVER: LLM =======================================
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_PROVIDER',
    label: 'LLM-Anbieter', type: 'enum', enumValues: ['ollama', 'openai'], def: 'ollama',
    applyMode: 'live',
    desc: 'ollama = natives Ollama-API (OLLAMA_URL/OLLAMA_MODEL, Keep-Warm). openai = '
      + 'beliebiger OpenAI-kompatibler Server (/chat/completions) — z. B. vLLM, AMD '
      + 'Lemonade, llama.cpp-Server, LM Studio — über LLM_BASE_URL/LLM_MODEL. Gilt für '
      + 'Antworten, rollende Zusammenfassung und die Session-Zusammenfassung beim Finalize. '
      + 'Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_BASE_URL',
    label: 'OpenAI-kompatible Basis-URL', type: 'string', def: '', applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt LLM_API_KEY an diese Adresse.',
    desc: 'Nur bei LLM_PROVIDER=openai: Basis-URL inklusive /v1, z. B. '
      + 'http://localhost:8000/v1 (vLLM) — den genauen Pfad nennt die Doku des jeweiligen '
      + 'Servers. Angefragt wird <URL>/chat/completions.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_MODEL',
    label: 'Modellname (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    desc: 'Nur bei LLM_PROVIDER=openai: Modellname, wie ihn der Server erwartet. Leer = '
      + 'OLLAMA_MODEL. SUMMARY_MODEL überschreibt ihn für die Zusammenfassung.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_API_KEY',
    label: 'API-Key (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'Optionaler Bearer-Token für LLM_PROVIDER=openai (lokale Server brauchen meist '
      + 'keinen). Secret — hier nur Status sichtbar; Änderung über .env.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_THINK',
    label: 'Denkphase (Ollama think)', type: 'enum',
    enumValues: ['false', 'true', 'low', 'medium', 'high', 'auto'], def: 'false', applyMode: 'live',
    desc: 'Steuert bei LLM_PROVIDER=ollama das Feld think jeder /api/chat-Anfrage (Antworten, '
      + 'rollende und Session-Zusammenfassung, Keep-Warm). false = Reasoning-Modelle (gemma4, '
      + 'qwen3, deepseek-r1 …) antworten direkt, ohne vorher zu „denken" — sonst erzeugt z. B. '
      + 'gemma4:12b über 1000 Denk-Tokens (~40 s) vor einer Antwort von zwei Sätzen. true = '
      + 'denken lassen; low/medium/high = Denkstufe (gpt-oss, das sich nicht abschalten lässt); '
      + 'auto = Feld weglassen (Standard des Modells). Lehnt ein Modell den Wert ab, fragt der '
      + 'Server einmal ohne think nach und merkt sich das. Bei LLM_PROVIDER=openai ohne Wirkung '
      + '(dort LLM_REASONING_EFFORT / LLM_CHAT_TEMPLATE_KWARGS). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_REASONING_EFFORT',
    label: 'reasoning_effort (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    desc: 'Nur bei LLM_PROVIDER=openai: wird als reasoning_effort mitgeschickt, z. B. none, '
      + 'minimal oder low, um die Denkphase eines Reasoning-Modells abzuschalten bzw. zu '
      + 'kürzen (welche Werte gelten, sagt die Doku des Servers). Leer = Feld wird nicht '
      + 'gesendet (Standard — ein strikter Server lehnt unbekannte Felder ab). Gilt nicht für '
      + 'einen separaten Zusammenfassungs-Server (SUMMARY_BASE_URL). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_CHAT_TEMPLATE_KWARGS',
    label: 'chat_template_kwargs (OpenAI-kompatibel)', type: 'string', def: '', applyMode: 'live',
    desc: 'Nur bei LLM_PROVIDER=openai: JSON-Objekt, das als chat_template_kwargs mitgeschickt '
      + 'wird — z. B. {"enable_thinking":false}, um bei vLLM, llama.cpp-Server oder SGLang die '
      + 'Denkphase von Qwen3 & Co. abzuschalten. Leer = nicht gesendet (Standard); kein '
      + 'gültiges JSON-Objekt = nicht gesendet + Warnung im Log. Gilt nicht für einen separaten '
      + 'Zusammenfassungs-Server (SUMMARY_BASE_URL). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · LLM (Ollama)', key: 'LLM_TIMEOUT_MS',
    label: 'LLM-Timeout (ms)', type: 'number', def: '120000', applyMode: 'live',
    desc: 'Maximale Dauer einer Antwort-Anfrage inklusive Generierung, bevor sie als '
      + 'fehlgeschlagen gilt (vorher: unbegrenzt — ein hängendes Modell blockierte die '
      + 'Antwort für immer). Wird pro Anfrage gelesen.',
  },
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
    desc: 'Ob Antworten auf SPRACH-Anfragen (Wake-Word) und Stop-Hinweise zusätzlich als '
      + 'Text in den Discord-Textkanal geschrieben werden. Standard: aus — Sprachausgabe + '
      + 'Transkript sind der primäre Ausgabeweg. Getippte Fragen (/ask, /recap, @Erwähnung) '
      + 'werden unabhängig davon immer im Kanal beantwortet. Wird pro Anfrage gelesen.',
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
    desc: 'Separates Modell für die rollende Zusammenfassung und die Session-Zusammenfassung '
      + 'beim Finalize (beide LLM-Anbieter). Leer = Antwort-Modell des Zusammenfassungs-'
      + 'Anbieters (OLLAMA_MODEL bzw. LLM_MODEL) — bei einem abweichenden SUMMARY_PROVIDER '
      + 'also hier den Modellnamen dieses Servers setzen. Wird pro Zusammenfassung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'SUMMARY_PROVIDER',
    label: 'Anbieter für Zusammenfassung', type: 'enum', enumValues: ['', 'ollama', 'openai'],
    def: '', applyMode: 'live',
    desc: 'Eigener LLM-Anbieter für die rollende und die Session-Zusammenfassung (z. B. ein '
      + 'größeres Modell auf einem anderen Server, damit lange Sessions im Zeitbudget '
      + 'SESSION_SUMMARY_TIMEOUT_MS fertig werden). Leer = wie LLM_PROVIDER. ollama = natives '
      + 'Ollama-API, openai = OpenAI-kompatibles /chat/completions. Server: SUMMARY_BASE_URL '
      + '(leer = OLLAMA_URL bzw. LLM_BASE_URL), Modell: SUMMARY_MODEL. Wird pro '
      + 'Zusammenfassung gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'SUMMARY_BASE_URL',
    label: 'Server-URL für Zusammenfassung', type: 'string', def: '', applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt SUMMARY_API_KEY an diese Adresse.',
    desc: 'Basis-URL des Zusammenfassungs-Servers — bei SUMMARY_PROVIDER=openai inklusive /v1 '
      + '(angefragt wird <URL>/chat/completions), bei ollama die Ollama-URL (<URL>/api/chat). '
      + 'Leer = OLLAMA_URL bzw. LLM_BASE_URL des gewählten Anbieters. Wird pro Zusammenfassung '
      + 'gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'SUMMARY_API_KEY',
    label: 'API-Key für Zusammenfassung', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'Optionaler Bearer-Token für den Zusammenfassungs-Server. Leer = LLM_API_KEY, aber '
      + 'nur, wenn die Zusammenfassung an denselben Server wie die Antworten geht — an eine '
      + 'andere SUMMARY_BASE_URL wird LLM_API_KEY nie geschickt. Ein Key geht nur an '
      + 'SUMMARY_BASE_URL bzw. LLM_BASE_URL (beide nur per .env änderbar), nie an die im '
      + 'Panel änderbare OLLAMA_URL. Secret — hier nur Status sichtbar; Änderung über .env.',
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
    desc: 'Wurzelverzeichnis des Obsidian-Vaults: Wissensbasis der semantischen Vault-Suche '
      + '(RAG, siehe RAG_ENABLED) und Basis für ein relatives CAMPAIGN_CONTEXT_FILE. Relativ '
      + 'ohne gesetzten Vault → Kampagnen-Kontext deaktiviert, leer → auch RAG aus. Wird beim '
      + 'Laden des Kontexts bzw. pro RAG-Anfrage gelesen (neuer Pfad → Indexer startet neu).',
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
      + 'übernommen werden. Gilt genauso für die RAG-Treffer pro Anfrage (beste Treffer '
      + 'zuerst). Wird beim Laden gelesen.',
  },

  // ======================= SERVER: RAG (Vault-Suche) ========================
  // Läuft im Server-Prozess (apps/server/src/rag/) — kein eigener Dienst.
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_ENABLED',
    label: 'Semantische Vault-Suche (RAG) aktiv', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'true', applyMode: 'live',
    desc: 'true = der Server indexiert den Obsidian-Vault (OBSIDIAN_VAULT_PATH) im Hintergrund '
      + 'und liefert pro Wake-Word-Query die passendsten Vault-Abschnitte statt des statischen '
      + 'CAMPAIGN.md. Embeddings kommen vom EMBED_PROVIDER (Standard: Ollama mit '
      + 'nomic-embed-text). Solange der Index noch nicht steht oder Embeddings fehlschlagen: '
      + 'Fallback auf CAMPAIGN.md. Ohne gesetzten Vault ist RAG immer aus. false = nur '
      + 'CAMPAIGN.md. Wird pro Anfrage geprüft — der Indexer startet/stoppt bei der nächsten Anfrage.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_TIMEOUT_MS',
    label: 'RAG-Timeout (ms)', type: 'number', def: '800', applyMode: 'live',
    desc: 'Zeitbudget pro RAG-Abfrage in ms (Embedding der Frage + Suche im Index); danach '
      + 'Fallback auf CAMPAIGN.md, die Voice-Pipeline wartet also höchstens so lange auf RAG. '
      + 'Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_SCORE_THRESHOLD',
    label: 'Max. Trefferdistanz (Score-Filter)', type: 'number', def: '', applyMode: 'live',
    desc: 'Maximale Cosine-Distanz für RAG-Treffer (Distanz = 1 − Cosinus-Ähnlichkeit: '
      + '0 = identisch, 1 = ohne Bezug, 2 = gegensätzlich). Treffer darüber werden verworfen, '
      + 'bevor sie in den LLM-Kontext gehen. Leer = kein Filter (immer die Top-K-Treffer). Mit '
      + 'nomic-embed-text liegen gute Treffer meist bei ~0.2–0.45, themenfremde ab ~0.55 — '
      + 'sinnvoller Startwert ~0.5; mit DEBUG=1 stehen die Distanzen jeder Abfrage im Log. '
      + 'Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_MAX_CHUNK_CHARS',
    label: 'Max. Zeichen pro Vault-Abschnitt', type: 'number', def: '2000', applyMode: 'live',
    desc: 'Notizen werden an jeder ##-Überschrift in Abschnitte geteilt; längere Abschnitte '
      + 'zusätzlich an Absatz-/Zeilengrenzen auf höchstens so viele Zeichen, damit ein einzelner '
      + 'Treffer den Prompt nicht flutet. Änderung → jede Notiz wird einmal neu eingebettet '
      + '(Indexer startet bei der nächsten Anfrage neu).',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_INDEX_DIR',
    label: 'Index-Verzeichnis', type: 'string', def: './data/rag', applyMode: 'live',
    desc: 'Wo der Vektor-Index (index.bin) gespeichert wird, relativ zu apps/server (Standard: '
      + 'DATA_DIR/rag bzw. ./data/rag; im Docker-Stack /data/rag auf dem server-data-Volume). '
      + 'Übersteht Neustarts — unveränderte Notizen werden nicht neu eingebettet. Löschen ist '
      + 'gefahrlos (wird aus dem Vault neu aufgebaut). Änderung greift bei der nächsten Anfrage.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'RAG_RESCAN_INTERVAL_MS',
    label: 'Periodischer Vault-Abgleich (ms)', type: 'number', def: '300000', applyMode: 'live',
    desc: 'Zusätzlich zum Datei-Watcher (Änderungen sofort, ~1 s entprellt) wird der Vault in '
      + 'diesem Abstand komplett abgeglichen — Absicherung für Plattformen/Sync-Clients, bei '
      + 'denen Datei-Ereignisse fehlen. Billig: nur geänderte Notizen werden neu eingebettet. '
      + '0 = aus. Änderung greift bei der nächsten Anfrage.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_PROVIDER',
    label: 'Embedding-Anbieter', type: 'enum', enumValues: ['ollama', 'openai'], def: 'ollama',
    applyMode: 'live',
    desc: 'Backend für die Vektoren der Vault-Suche. ollama = /api/embed auf OLLAMA_URL '
      + '(Standard). openai = beliebiger OpenAI-kompatibler /embeddings-Endpunkt auf '
      + 'EMBED_BASE_URL (vLLM, llama.cpp-Server, LM Studio, AMD Lemonade …). Ein Wechsel '
      + 'verwirft den Index und baut ihn mit dem neuen Modell komplett neu auf.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_BASE_URL',
    label: 'Embedding-Server-URL (openai)', type: 'string', def: '', applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt EMBED_API_KEY an diese Adresse.',
    desc: 'Basis-URL inkl. /v1 für EMBED_PROVIDER=openai, z. B. http://localhost:8000/v1. '
      + 'Bei EMBED_PROVIDER=ollama ungenutzt (dann gilt OLLAMA_URL). Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_MODEL',
    label: 'Embedding-Modell', type: 'string', def: 'nomic-embed-text', applyMode: 'live',
    desc: 'Modell für die Vektoren (bei Ollama vorher: ollama pull <modell>). Ein Wechsel '
      + 'verwirft den Index und bettet den ganzen Vault neu ein — Vektoren verschiedener '
      + 'Modelle sind nicht vergleichbar. Bis dahin Fallback auf CAMPAIGN.md.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_API_KEY',
    label: 'Embedding-API-Key (openai)', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'Optionaler Bearer-Token für EMBED_PROVIDER=openai. Secret — hier nur Status '
      + 'sichtbar; Änderung über .env. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_KEEP_ALIVE',
    label: 'Embedding-Modell-Verweildauer (Ollama)', type: 'string', def: '30m', applyMode: 'live',
    desc: 'Wie lange Ollama das Embedding-Modell nach einem Aufruf geladen hält (z. B. 30m, '
      + '-1 = dauerhaft). Sonst zahlt die erste Abfrage nach einer Pause das Nachladen und '
      + 'reißt das RAG-Timeout. Nur bei EMBED_PROVIDER=ollama. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_QUERY_PREFIX',
    label: 'Präfix für Suchanfragen', type: 'string', def: '', applyMode: 'live',
    desc: 'Task-Präfix vor jeder Suchanfrage. Leer = automatisch (nomic-Modelle: '
      + '„search_query: ", andere: keins); ein einzelnes Leerzeichen = kein Präfix. Änderung → '
      + 'Index wird neu aufgebaut.',
  },
  {
    scope: 'server', group: 'Server · RAG (Vault-Suche)', key: 'EMBED_DOC_PREFIX',
    label: 'Präfix für Vault-Abschnitte', type: 'string', def: '', applyMode: 'live',
    desc: 'Task-Präfix vor jedem indexierten Abschnitt. Leer = automatisch (nomic-Modelle: '
      + '„search_document: ", andere: keins); ein einzelnes Leerzeichen = kein Präfix. '
      + 'Änderung → Index wird neu aufgebaut.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LAST_SESSION_CONTEXT_ENABLED',
    label: 'Letzte Session als Kontext', type: 'boolean', onValue: 'true', offValue: 'false',
    def: 'true', applyMode: 'live',
    desc: 'Gibt Rabenauge bei jeder Anfrage die Zusammenfassung der zuletzt finalisierten '
      + 'Session (summary.md im Archiv) als Hintergrund mit — damit beantwortet er „Was war '
      + 'letztes Mal?" bzw. /recap. Nur auf Nachfrage: der Kontext ist als „nicht ungefragt '
      + 'nacherzählen" markiert, es gibt keine Begrüßung beim /join. Wird pro Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · Live- & Kampagnen-Kontext', key: 'LAST_SESSION_CONTEXT_MAX_CHARS',
    label: 'Letzte Session: max. Zeichen', type: 'number', def: '2500', applyMode: 'live',
    desc: 'Obergrenze für den Kontextblock der letzten Session (gekürzt am Satzende).',
  },

  // ======================= SERVER: TTS ======================================
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_PROVIDER',
    label: 'TTS-Anbieter', type: 'enum', enumValues: ['piper', 'openai', 'elevenlabs'], def: 'piper',
    applyMode: 'live',
    desc: 'Sprachsynthese-Backend. piper = lokaler Piper-Server (Standard, TTS_URL). '
      + 'openai = beliebiger OpenAI-kompatibler /audio/speech-Endpunkt (z. B. vLLM-Omni mit '
      + 'Qwen3-TTS, AMD Lemonade/Kokoro, Speaches oder OpenAI selbst; TTS_BASE_URL, '
      + 'TTS_MODEL, TTS_VOICE). elevenlabs = Cloud-Stimmen (benötigt ELEVENLABS_API_KEY + '
      + 'ELEVENLABS_VOICE_ID). Stimmung (speaker_id 0–7) und Modell „emotional/high" aus der '
      + 'LLM-Antwort wirken nur bei piper — die anderen Anbieter sprechen immer mit der '
      + 'konfigurierten Stimme. Wird pro TTS-Anfrage gelesen: Umschalten greift bei der '
      + 'nächsten Antwort.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_TIMEOUT_MS',
    label: 'TTS-Timeout (ms)', type: 'number', def: '30000', applyMode: 'live',
    desc: 'Gilt für alle Anbieter: maximale Wartezeit bis der TTS-Server antwortet und '
      + 'zwischen zwei Audio-Datenpaketen. Stockt der Server mitten im Satz länger, endet die '
      + 'Wiedergabe mit einem Fehler, statt ewig zu hängen. Begrenzt NICHT die Gesamtdauer — '
      + 'ein langer Satz, der stetig weiterstreamt, läuft durch. 0 = kein Timeout. Wird pro '
      + 'TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_URL',
    label: 'Piper-Server-URL', type: 'string', def: 'http://localhost:5000', applyMode: 'live',
    desc: 'Basis-URL des lokalen Piper-TTS-Servers (bei TTS_PROVIDER=piper); angefragt wird '
      + '<URL>/tts/synthesize. Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_BASE_URL',
    label: 'OpenAI-kompatible TTS-URL', type: 'string', def: '', applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt TTS_API_KEY an diese Adresse.',
    desc: 'Basis-URL des OpenAI-kompatiblen TTS-Servers inklusive /v1 (bei '
      + 'TTS_PROVIDER=openai), z. B. http://localhost:8000/v1 oder https://api.openai.com/v1. '
      + 'Angefragt wird <URL>/audio/speech. Pflicht bei openai. Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_MODEL',
    label: 'TTS-Modell (openai)', type: 'string', def: '', applyMode: 'live',
    desc: 'Wert für das Feld "model" der /audio/speech-Anfrage (bei TTS_PROVIDER=openai): der '
      + 'Modellname, unter dem der Server das TTS-Modell anbietet (siehe dessen /v1/models), '
      + 'z. B. gpt-4o-mini-tts bei OpenAI oder kokoro bei Kokoro-Servern. Leer = Feld wird '
      + 'weggelassen (Server-Standard). Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_VOICE',
    label: 'TTS-Stimme (openai)', type: 'string', def: '', applyMode: 'live',
    desc: 'Wert für das Feld "voice" (bei TTS_PROVIDER=openai): Stimmen- bzw. Sprecher-Name '
      + 'laut Doku des Servers, z. B. alloy bei OpenAI. Leer = Feld wird weggelassen '
      + '(Server-Standard). Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_API_KEY',
    label: 'TTS-API-Key (openai)', type: 'string', def: '', applyMode: 'live',
    secret: true, editable: false,
    desc: 'API-Schlüssel (Bearer) für den OpenAI-kompatiblen TTS-Server. Optional — lokale '
      + 'Server brauchen meist keinen. Secret — hier nur Status sichtbar; Änderung über .env. '
      + 'Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_RESPONSE_FORMAT',
    label: 'Audioformat (openai)', type: 'enum', enumValues: ['pcm', 'wav'], def: 'pcm',
    applyMode: 'live',
    desc: 'Feld "response_format" (bei TTS_PROVIDER=openai). pcm = rohes 16-Bit-Mono-PCM ohne '
      + 'Header, Abtastrate laut TTS_SAMPLE_RATE (OpenAI-Standard). wav = WAV mit Header — '
      + 'Abtastrate und Kanäle stehen im Header (Stereo wird zu Mono gemischt); robuster, wenn '
      + 'unklar ist, mit welcher Rate der Server PCM liefert. Komprimierte Formate (mp3, opus …) '
      + 'werden nicht unterstützt und mit klarer Fehlermeldung abgelehnt. Wird pro TTS-Anfrage '
      + 'gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_SAMPLE_RATE',
    label: 'PCM-Abtastrate (Hz, openai)', type: 'number', def: '24000', applyMode: 'live',
    desc: 'Abtastrate, mit der rohes PCM (TTS_RESPONSE_FORMAT=pcm) interpretiert wird. Laut '
      + 'OpenAI-Spezifikation 24000. Ein falscher Wert lässt die Stimme zu hoch und schnell '
      + 'bzw. zu tief und langsam klingen — im Zweifel TTS_RESPONSE_FORMAT=wav verwenden. Bei '
      + 'wav ohne Bedeutung. Wird pro TTS-Anfrage gelesen.',
  },
  {
    scope: 'server', group: 'Server · TTS', key: 'TTS_SPEED',
    label: 'Sprechtempo (openai)', type: 'number', def: '', applyMode: 'live',
    desc: 'Feld "speed" (bei TTS_PROVIDER=openai), 0.25–4.0, 1 = normal. Leer = Feld wird '
      + 'weggelassen (Server-Standard); nicht jeder Server wertet es aus. Fordert eine Anfrage '
      + 'ein Piper-Tempo (lengthScale) an, wird dessen Kehrwert mit diesem Wert '
      + 'multipliziert. Wird pro TTS-Anfrage gelesen.',
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
  {
    scope: 'server', group: 'Server · TTS', key: 'ELEVENLABS_BASE_URL',
    label: 'ElevenLabs-API-URL', type: 'string', def: 'https://api.elevenlabs.io',
    applyMode: 'live',
    editable: false, note: 'Nur per .env änderbar: der Server schickt ELEVENLABS_API_KEY an diese Adresse.',
    desc: 'Basis-URL der ElevenLabs-API ohne /v1 (bei TTS_PROVIDER=elevenlabs). Nur ändern für '
      + 'einen regionalen Endpunkt oder einen Proxy. Wird pro TTS-Anfrage gelesen.',
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
    editable: false, note: 'Nur per .env auf dem Bot-Host änderbar: der Bot schickt CONTROL_BEARER an diese Adresse.',
    applyMode: 'reconnect',
    desc: 'ws:// oder wss:// Basis-URL des LAN-Servers. Der Bot verbindet sich hierüber '
      + 'zu /control, /uplink, /downlink. Wird beim Verbindungsaufbau gelesen — greift '
      + 'beim nächsten Reconnect.',
  },
  {
    scope: 'bot', group: 'Bot · Server-Verbindung', key: 'CONTROL_WS_URL',
    label: 'Control-WS-URL (Alternative)', type: 'string', def: '', applyMode: 'reconnect',
    editable: false, note: 'Nur per .env auf dem Bot-Host änderbar: der Bot schickt CONTROL_BEARER an diese Adresse.',
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
    editable: false, note: 'Nur per .env auf dem Bot-Host änderbar: Shell-Kommando — über das Panel wäre es Remote-Code-Ausführung.',
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
    editable: false, note: 'Nur per .env auf dem Bot-Host änderbar: Shell-Kommando — über das Panel wäre es Remote-Code-Ausführung.',
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
  {
    scope: 'bot', group: 'Bot · Daten & Session', key: 'AUTO_FINALIZE_AFTER_LEAVE',
    label: 'Auto-Finalize nach /leave', type: 'boolean', def: 'true', applyMode: 'restart',
    desc: 'Finalisiert eine verlassene Session (/leave, Voice-Abbruch) automatisch, sobald '
      + 'SESSION_IDLE_HOURS seit der letzten Aktivität vergangen sind — auch nach einem '
      + 'Bot-Neustart. Baut dafür die Server-Verbindung selbst auf und startet den Server '
      + 'per SERVER_START_CMD, falls nötig (Cloud: startet also eine GPU-Instanz). '
      + 'false = nur manuell per /finalize run.',
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
    editable: false, note: 'Nur per .env auf dem Bot-Host änderbar: Shell-Kommando — über das Panel wäre es Remote-Code-Ausführung.',
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

  // ======================= BOT: Finalize-Wartezeit ==========================
  {
    scope: 'bot', group: 'Bot · Finalize-Wartezeit', key: 'FINALIZE_IDLE_TIMEOUT_MS',
    label: 'Finalize: Abbruch ohne Fortschritt (ms)', type: 'number', def: '600000',
    applyMode: 'live',
    desc: 'Der Bot wartet auf das Ergebnis des Server-Finalize, solange Fortschritt kommt: '
      + 'jede Fortschrittsmeldung (x/N Äußerungen, Zusammenführen, Zusammenfassung, Audio; '
      + 'der Server meldet sich während eines Laufs mindestens einmal pro Minute) startet '
      + 'diese Frist neu. Erst wenn so lange gar nichts kommt — Server hängt, abgestürzt '
      + 'oder die Verbindung bleibt weg —, gibt der Bot auf; die Session bleibt dann offen '
      + 'und kann mit /finalize run erneut finalisiert werden. Default 600000 (10 Minuten), '
      + 'mindestens 120000. Wird pro Finalize gelesen.',
  },
  {
    scope: 'bot', group: 'Bot · Finalize-Wartezeit', key: 'FINALIZE_MAX_MS',
    label: 'Finalize: maximale Gesamtdauer (ms)', type: 'number', def: '10800000',
    applyMode: 'live',
    desc: 'Obergrenze für das Warten auf einen Finalize, auch wenn weiter Fortschritt '
      + 'kommt — nur ein Netz gegen einen Lauf, der nie endet. Eine 3-Stunden-Session '
      + 'braucht für Nach-Transkription + Zusammenfassung etwa eine halbe Stunde (je nach '
      + 'GPU). Default 10800000 (3 Stunden), mindestens 600000. Wird pro Finalize gelesen.',
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
