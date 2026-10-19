# Prompts im Vault pflegen

Rabenauge hat vier LLM-Prompts eingebaut. Jeden davon kann eine Datei ersetzen,
z. B. eine Notiz im Obsidian-Vault, die du (oder Claude Cowork) dort pflegst.
Die vier Dateien hier sind die eingebauten Texte als Vorlage.

| Vorlage | Einstellung | Wofür | Wirkt |
|---|---|---|---|
| [`Prompt Persona.md`](Prompt%20Persona.md) | `SYSTEM_PROMPT_FILE` | Persona und Antwortregeln (JSON für die Sprachausgabe) | bei der nächsten Antwort |
| [`Prompt Sitzung Abschnitt.md`](Prompt%20Sitzung%20Abschnitt.md) | `SESSION_SUMMARY_PART_PROMPT_FILE` | Finalize: einen Abschnitt des Transkripts zu Notizen verdichten | beim nächsten Finalize |
| [`Prompt Sitzung Zusammenfassung.md`](Prompt%20Sitzung%20Zusammenfassung.md) | `SESSION_SUMMARY_FINAL_PROMPT_FILE` | Finalize: die Session-Zusammenfassung (`summary.md`) | beim nächsten Finalize |
| [`Prompt Live-Zusammenfassung.md`](Prompt%20Live-Zusammenfassung.md) | `LIVE_SUMMARY_PROMPT_FILE` | rollende Zusammenfassung während der Session | bei der nächsten Zusammenfassung |

## Einrichten

1. Die vier `Prompt *.md` in den Vault kopieren, Vorschlag:

   ```
   <Vault>/
     Rabenauge/
       Konfiguration/
         Prompt Persona.md
         Prompt Sitzung Abschnitt.md
         Prompt Sitzung Zusammenfassung.md
         Prompt Live-Zusammenfassung.md
       Sessions/              ← optional, SESSION_SUMMARY_VAULT_DIR
   ```

2. In `apps/server/.env` (oder im Web-Panel) eintragen:

   ```
   SYSTEM_PROMPT_FILE=Rabenauge/Konfiguration/Prompt Persona.md
   SESSION_SUMMARY_PART_PROMPT_FILE=Rabenauge/Konfiguration/Prompt Sitzung Abschnitt.md
   SESSION_SUMMARY_FINAL_PROMPT_FILE=Rabenauge/Konfiguration/Prompt Sitzung Zusammenfassung.md
   LIVE_SUMMARY_PROMPT_FILE=Rabenauge/Konfiguration/Prompt Live-Zusammenfassung.md
   ```

   Nur die Prompts eintragen, die du ändern willst; die übrigen bleiben eingebaut.

3. Den Ordner aus der Vault-Suche heraushalten, sonst kommen die Prompts als
   „Kampagnen-Kontext" in Antworten zurück: `RAG_EXCLUDE=Rabenauge/Konfiguration/`
   (siehe [`docs/rag.md`](../rag.md)). Wird der Vault als Wiki veröffentlicht,
   den Ordner auch dort ausnehmen.

### Pfade

- absolut: so wie er ist;
- beginnt mit `./` oder `../`: relativ zum Arbeitsverzeichnis des Servers
  (`apps/server`), also wie bisher `SYSTEM_PROMPT_FILE=./prompt.txt`;
- sonst: relativ zu `OBSIDIAN_VAULT_PATH` (ohne Vault: wie `./`).

### Format

Eine normale Notiz. YAML-Frontmatter und `%% Kommentare %%` gehen nicht ans
Modell, alles andere wörtlich (auch Überschriften und Listen). In den Vorlagen
steht im Kommentarblock, was der Server selbst anhängt:

- Session-Zusammenfassung: die korrekten Schreibweisen der Namen
  (`STT_VOCABULARY`/`_FILE`) und den Hintergrund (Auszug aus `CAMPAIGN.md`,
  Zusammenfassung der vorigen Sitzung, mit der Regel, nichts davon als Ereignis
  dieser Sitzung zu übernehmen) an den Prompt, und als Nachricht den Abschnitt
  bzw. die Notizen samt „Höchstens N Zeichen.".
- Persona: die Kontextblöcke („Zusammenfassung der letzten abgeschlossenen
  Sitzung", „Bisheriger Gesprächsverlauf (Zusammenfassung)", „Aktuelles
  Live-Transkript der Runde", und direkt vor der Frage „Neueste Beiträge im
  Live-Transkript (Fortsetzung)" und „Kampagnen-Kontext"). Das JSON-Format der
  Antwort muss bleiben, der Server liest daraus Text, Stimme und Modell
  (`LLM_JSON_FORMAT` erzwingt es bei Ollama).

Die Session-Zusammenfassung endet mit einer Zeile `Ort: … · Ingame-Datum: …`,
wenn das im Spiel genannt wurde. Beim Kürzen bleibt eine letzte Zeile, die mit
`Ort:` oder `Ingame-Datum:` beginnt, erhalten.

Zwischen-Zusammenführungen (nur bei sehr langen Sessions, wenn die Notizen
nicht in einen Aufruf passen) nutzen immer den eingebauten Text.

### Wenn etwas fehlt

Ist die Datei nicht da, nicht lesbar oder leer (nur Frontmatter/Kommentare),
nimmt der Server den eingebauten Prompt (bei der Persona zuerst
`SYSTEM_PROMPT`) und schreibt **eine** Warnung ins Log:

```
[WARN] prompt: SESSION_SUMMARY_FINAL_PROMPT_FILE …\Prompt Sitzung Zusammenfassung.md not readable (ENOENT) — using the built-in prompt
```

Wird eine Datei geladen oder geändert, steht das als `[INFO] prompt: … loaded
from …` im Log.

## Vorhandene `prompt.txt` übernehmen

Wer schon eine eigene `apps/server/prompt.txt` hat: ihren Inhalt in
`Prompt Persona.md` (unter den Kommentarblock) kopieren und den Abschnitt
`KONTEXT:` durch den aus der Vorlage ersetzen. Seit v2.1 kam die
Zusammenfassung der letzten Sitzung dazu; seit dem Vorwärmen (`LLM_PRIME`)
stehen die neuesten Transkriptzeilen und der Kampagnen-Kontext direkt vor der
Frage.

## Für Entwickler

Die Vorlagen entsprechen den eingebauten Texten (`DEFAULT_SYSTEM` in
`apps/server/src/llm.js`, `PART_SYSTEM`/`FINAL_SYSTEM` in
`apps/server/src/finalize/summary.js`, `SUMMARY_SYSTEM` in
`apps/server/src/rollingSummary.js`); `apps/server/test/promptFiles.test.js`
prüft das. Wer einen eingebauten Prompt ändert, ändert die Vorlage mit.
