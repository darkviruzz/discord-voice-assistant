// Boot-Reihenfolge-kritisch: MUSS als allererstes Modul importiert werden
// (vor logger.js und allen Modulen, die ENV-Konstanten beim Import lesen).
//
//   1. dotenv lädt .env in process.env.
//   2. applyServerOverrides() legt die persistierten Server-Overrides obendrauf.
//
// So sehen auch Modul-Konstanten (DEBUG, HOST, PORT, ARCHIVE_OPUS_BITRATE,
// SYSTEM_PROMPT_FILE …) beim ersten Import bereits den effektiven Wert.
import 'dotenv/config';
import { applyServerOverrides } from './configStore.js';

applyServerOverrides();
