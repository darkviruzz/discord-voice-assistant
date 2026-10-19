// Candidate names for the STT vocabulary (STT_VOCABULARY_FILE), derived from an
// Obsidian vault: titles (+ frontmatter aliases) of character, NPC, place and
// faction notes, ranked by how many of the most recent session notes mention
// them. The result is a SUGGESTION for a human to review — nothing here writes
// into the vault or the server config.

import { parseFrontmatter } from '../../apps/server/src/rag/frontmatter.js';
import { VOCAB_MAX_CHARS } from '../../apps/server/src/sttVocabulary.js';

// Category by frontmatter `type` first, then by folder name (a leading
// "30_"-style sort prefix is ignored). Order = output order.
export const CATEGORIES = [
  { key: 'pc', label: 'Spielercharakter', types: ['pc', 'spielercharakter'], dirs: ['characters', 'character', 'charaktere', 'spielercharaktere', 'pcs'] },
  { key: 'companion', label: 'Gefährte', types: ['sidekick', 'companion', 'begleiter', 'gefährte'], dirs: ['sidekicks', 'gefährten', 'companions', 'begleiter'] },
  { key: 'npc', label: 'NSC', types: ['npc', 'nsc'], dirs: ['npcs', 'npc', 'nscs', 'nsc'] },
  { key: 'place', label: 'Ort', types: ['location', 'ort', 'place', 'city', 'stadt', 'region'], dirs: ['locations', 'orte', 'places'] },
  { key: 'faction', label: 'Fraktion', types: ['faction', 'fraktion', 'organisation', 'organization'], dirs: ['factions', 'fraktionen'] },
];

const segName = (s) => s.toLowerCase().replace(/^\d+[_ .-]*/, '');

export function categoryOf(source, meta = {}) {
  const type = String(Array.isArray(meta.type) ? meta.type[0] : meta.type ?? '').trim().toLowerCase();
  if (type) {
    const byType = CATEGORIES.find((c) => c.types.includes(type));
    if (byType) return byType.key;
  }
  const dirs = source.split('/').slice(0, -1).map(segName);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const byDir = CATEGORIES.find((c) => c.dirs.includes(dirs[i]));
    if (byDir) return byDir.key;
  }
  return null;
}

export const isSessionNote = (source) => source.split('/').slice(0, -1).some((d) => /session/i.test(d));

// Note templates carry `type: NPC` etc. but are not names.
const isTemplate = (source) => source.split('/').slice(0, -1).some((d) => /^(templates?|vorlagen?)$/i.test(segName(d)));

// "Elsbeth (Piratin)" → "Elsbeth"; the title as players say it.
export function spokenName(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function aliasesOf(meta) {
  const a = meta.aliases ?? meta.alias;
  const list = Array.isArray(a) ? a : (a == null ? [] : [a]);
  return list.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, case-insensitive (letters/digits on either side = no match).
function mentionRe(name) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu');
}

// notes: [{ source, text }] (vault-relative path with "/", full file text).
// → { entries: [{ name, category, alias?, of?, sessions, links }], recent }
export function collectCandidates(notes, { recent = 10 } = {}) {
  const parsed = notes.map((n) => ({ ...n, ...parseFrontmatter(n.text) }));
  const sessions = parsed.filter((n) => isSessionNote(n.source))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .slice(-Math.max(0, recent));

  // Vault-wide [[wikilink]] counts per target title (lower-case basename).
  const links = new Map();
  for (const n of parsed) {
    for (const m of n.text.matchAll(/\[\[([^\]|#]+)/g)) {
      const t = m[1].split('/').pop().trim().toLowerCase();
      links.set(t, (links.get(t) ?? 0) + 1);
    }
  }

  const entities = [];
  for (const n of parsed) {
    const category = isTemplate(n.source) ? null : categoryOf(n.source, n.meta);
    if (!category) continue;
    const title = n.source.split('/').pop().replace(/\.md$/i, '');
    entities.push({ title, name: spokenName(title), category, aliases: aliasesOf(n.meta) });
  }
  // "Faylith Tarneth – Hintergrund" is a sub-page of "Faylith Tarneth".
  const titles = new Set(entities.map((e) => e.title.toLowerCase()));
  const main = entities.filter((e) => {
    const m = /^(.+?)\s+[–—-]\s+\S/.exec(e.title);
    return !(m && titles.has(m[1].toLowerCase()));
  });

  const countSessions = (forms) => {
    const res = forms.map(mentionRe);
    return sessions.filter((s) => res.some((re) => re.test(s.body))).length;
  };

  const entries = [];
  const seen = new Set();
  for (const e of main) {
    const key = e.name.toLowerCase();
    if (!e.name || seen.has(key)) continue;
    seen.add(key);
    // Aliases contained in the name ("Gaglath" in "Gaglath Matho") need no
    // own entry — the name already teaches their spelling; they still count
    // as mentions of it.
    const extra = e.aliases.filter((a) => !mentionRe(a).test(e.name));
    entries.push({
      name: e.name, category: e.category,
      sessions: countSessions([e.name, ...e.aliases]),
      links: links.get(e.title.toLowerCase()) ?? 0,
    });
    for (const a of extra) {
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      entries.push({ name: a, category: e.category, alias: true, of: e.name, sessions: countSessions([a]), links: 0 });
    }
  }
  return { entries, recent: sessions.length };
}

// Output order: player characters, companions, then everything else — each
// part by recent session mentions, then link count, then name.
export function rankCandidates(entries) {
  const part = (e) => (e.category === 'pc' ? 0 : e.category === 'companion' ? 1 : 2);
  return [...entries].sort((a, b) => part(a) - part(b) || b.sessions - a.sessions || b.links - a.links
    || a.name.localeCompare(b.name, 'de'));
}

// Render the reviewable list. Lines without `#` go into the prompt: names with
// at least one recent session mention, in rank order, while they fit
// VOCAB_MAX_CHARS together; every other candidate is a commented-out line.
// The text is in the format the server's parseVocabulary() reads.
export function renderCandidates(entries, { vault = '', recent = 0, now = new Date() } = {}) {
  const ranked = rankCandidates(entries);
  const label = (k) => CATEGORIES.find((c) => c.key === k)?.label ?? k;
  const note = (e) => `${label(e.category)}${e.alias ? ` · Alias von ${e.of}` : ''} · ${e.sessions}/${recent} Sessions · ${e.links} Links`;
  const width = Math.min(32, Math.max(0, ...ranked.map((e) => e.name.length)) + 2);
  const line = (e, active) => `${active ? '' : '# '}${e.name.padEnd(width)}# ${note(e)}`;

  const active = new Set();
  let len = 1; // closing "."
  for (const e of ranked) {
    if (e.sessions < 1) continue;
    const add = (active.size ? 2 : 0) + e.name.length;
    if (len + add > VOCAB_MAX_CHARS) continue;
    active.add(e);
    len += add;
  }

  const out = [
    `# STT-Vokabular — Kandidaten aus ${vault || 'dem Vault'} (npm run vocab:stt, ${now.toISOString().slice(0, 10)})`,
    '# VORSCHLAG — bitte prüfen: nur Namen, die Whisper falsch schreibt; gängige Wörter kosten nur Budget.',
    `# Zeilen ohne # gehen in den Prompt (zusammen ≤ ${VOCAB_MAX_CHARS} Zeichen, Reihenfolge = Priorität).`,
    '# Auskommentierte Zeilen sind weitere Kandidaten. Danach als STT_VOCABULARY_FILE ablegen.',
    `# "Sessions" = Erwähnungen in den letzten ${recent} Session-Notizen.`,
  ];
  let lastPart = null;
  const headings = ['Spielercharaktere', 'Gefährten', 'NSCs, Orte, Fraktionen'];
  for (const e of ranked) {
    const p = e.category === 'pc' ? 0 : e.category === 'companion' ? 1 : 2;
    if (p !== lastPart) { out.push('', `# ${headings[p]}`); lastPart = p; }
    out.push(line(e, active.has(e)));
  }
  out.push('', `# ${active.size} Namen aktiv, ${len} Zeichen Prompt.`);
  return { text: `${out.join('\n')}\n`, active: [...active].map((e) => e.name) };
}
