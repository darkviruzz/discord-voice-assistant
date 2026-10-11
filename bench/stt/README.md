# STT-Benchmark

Vergleicht STT-Provider/-Modelle objektiv an **euren** Aufnahmen — über genau
den Transkriptionspfad, den auch `/finalize` nutzt (Stille-Split → Provider →
Token-Merge).

## Dateien ablegen

```
bench/stt/
  <name>.wav|m4a|mp3|ogg|flac|opus   Aufnahme (beliebiges Format, ffmpeg dekodiert)
  <name>.txt                         korrigiertes Referenz-Transkript (nur Text)
  names.txt                          Eigennamen, eine Zeile pro Name (# = Kommentar)
  profiles.json                      zu vergleichende Provider (optional)
```

Audio, Referenzen, `names.txt`, `profiles.json` und `results/` sind
gitignored — echte Session-Aufnahmen landen nie im Repo. Gut geeignet sind
2–5 Minuten mit vielen Eigennamen, mehreren Sprechern und typischen
Störgeräuschen (Würfel, Lachen, Durcheinanderreden). Die Referenz muss nur den
gesprochenen Text enthalten; Groß-/Kleinschreibung und Satzzeichen zählen nicht.

## Profile

`profiles.json` ist ein Array aus `{ "name", "env" }`; `env` überschreibt für
diesen Lauf die Werte aus `apps/server/.env`. Vorlage:
[`profiles.example.json`](profiles.example.json). Ohne Datei läuft genau ein
Profil mit der aktuellen Server-Konfiguration.

## Ausführen

```bash
npm run bench:stt                      # alle Samples × alle Profile
npm run bench:stt -- --only whisper-large-v3-turbo
npm run bench:stt -- --with-example    # + tests/Quantengravitation.m4a
```

Ausgabe: Tabelle mit WER (S/D/I), CER, **Namen-Recall** (Anteil korrekt
erkannter Eigennamen-Vorkommen — die Zahl, auf die es bei einer Kampagne
ankommt) und RTF (Rechenzeit / Audiodauer). Report + alle Hypothesen-Texte
liegen unter `bench/stt/results/<zeitstempel>/`.
