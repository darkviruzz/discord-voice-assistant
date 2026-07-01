// Boot-Reihenfolge-kritisch: MUSS als sehr frühes Modul importiert werden
// (nach dotenv, aber vor session.js/logger.js und allem, was ENV-Konstanten
// beim Import liest). Legt die persistierten Bot-Overrides auf process.env.
import 'dotenv/config';
import { applyOverridesAtBoot } from './configOverrides.js';

applyOverridesAtBoot();
