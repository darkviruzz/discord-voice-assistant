import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinalizeStatus, formatProgress, finalizeResultText } from '../src/finalizeStatus.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChannel() {
  const log = [];
  const ch = {
    log,
    async send(content) {
      log.push(['send', content]);
      return { async edit(c) { log.push(['edit', c]); } };
    },
  };
  return ch;
}

test('posts once, throttles progress edits, latest text wins, final always shown', async () => {
  const ch = fakeChannel();
  const s = new FinalizeStatus({ resolveChannel: async () => ch, header: '🗄️ Session X', minIntervalMs: 40 });
  await s.start('gestartet');
  s.update('1/10');
  s.update('2/10');
  s.update('3/10');
  await sleep(10);
  assert.deepEqual(ch.log, [['send', '🗄️ Session X\ngestartet']], 'no edit inside the throttle window');
  await sleep(60);
  await s.chain;
  assert.deepEqual(ch.log.at(-1), ['edit', '🗄️ Session X\n3/10'], 'only the latest pending text is shown');
  assert.equal(ch.log.length, 2);
  s.update('4/10');
  await s.done('✅ fertig');
  await sleep(60);
  await s.chain;
  assert.deepEqual(ch.log.at(-1), ['edit', '🗄️ Session X\n✅ fertig']);
  assert.ok(!ch.log.some(([, c]) => c.endsWith('4/10')), 'a pending update after done() is dropped');
  s.update('5/10');
  await sleep(60);
  assert.ok(!ch.log.some(([, c]) => c.endsWith('5/10')), 'updates after done() are ignored');
});

test('no channel → silent; Discord errors never throw', async () => {
  const s = new FinalizeStatus({ resolveChannel: async () => null, minIntervalMs: 0 });
  await s.start('x');
  s.update('y');
  await s.fail('z');
  const broken = { async send() { throw new Error('Missing Access'); } };
  const s2 = new FinalizeStatus({ resolveChannel: async () => broken, minIntervalMs: 0 });
  await s2.start('x');
  await s2.fail('boom');
});

test('fail() without a prior start still posts the error (e.g. server unreachable)', async () => {
  const ch = fakeChannel();
  const s = new FinalizeStatus({ resolveChannel: async () => ch, header: 'H' });
  await s.fail('❌ Server nicht erreichbar');
  assert.deepEqual(ch.log, [['send', 'H\n❌ Server nicht erreichbar']]);
});

test('formatProgress renders server phases in German', () => {
  assert.equal(formatProgress({ phase: 'stt', done: 37, total: 120 }), '⏳ Transkribiere 37/120 Äußerungen (30 %) …');
  assert.equal(formatProgress({ phase: 'started', utterances: 12 }), '⏳ Server transkribiert 12 Äußerungen …');
  assert.match(formatProgress({ phase: 'joined' }), /läuft bereits/);
  assert.match(formatProgress({ phase: 'audio' }), /Audio-Archiv/);
  assert.equal(formatProgress({ phase: 'weird' }), '⏳ weird …');
});

// Worst case: a checkout deep under a OneDrive folder (archive paths ~235
// chars, still below Windows' MAX_PATH), incomplete uploads + archive-pull
// notes, a 2500-char recap. The old fixed 1100-char recap cap gave a final
// edit of 2003 chars — Discord rejects > 2000, the edit failed and the status
// stayed on its last progress line.
test('final status stays within one Discord message; the recap is shortened, not the facts', async () => {
  const id = '2026-10-11T19-00-00-000Z';
  const base = 'C:\\Users\\Markus.Mustermann\\OneDrive - Universität Musterstadt\\Dokumente\\Rollenspiel\\Greyhawk Kampagne 2026 (Spielrunde Donnerstag)\\Server-Ablage\\discord-voice-assistant-main\\apps\\server';
  const result = {
    userCount: 1234, spanCount: 1789, audioOk: true, audioCount: 1235,
    transcriptPath: `${base}\\transcripts\\${id}\\transcript.md`,
    archiveDir: `${base}\\archive\\${id}`,
    summary: 'Die Gruppe erreichte Burg Rabenstein und verhandelte lange mit Baron Kelthur über das Lösegeld. '.repeat(26).trim(),
  };
  const notes = ' ⚠️ 2 fehlende / 1 fehlerhafte Uploads – lokale WAVs bleiben für erneuten Versuch erhalten.'
    + ' ⚠️ Archiv-Pull unvollständig (3 Datei(en) fehlgeschlagen) — stop.sh --backup bleibt als Netz.';
  const ch = fakeChannel();
  const s = new FinalizeStatus({ resolveChannel: async () => ch, header: `🗄️ **Finalize** Session \`${id}\` — automatisch (Inaktivität nach /leave)`, minIntervalMs: 0 });
  await s.start('⏳ Startet …');
  await s.done(finalizeResultText(result, notes, { maxChars: s.textRoom() }));
  const final = ch.log.at(-1)[1];
  assert.ok(final.length <= 2000, `final status has ${final.length} chars`);
  assert.ok(final.includes(result.transcriptPath) && final.includes(result.archiveDir), 'paths are never cut');
  assert.ok(final.includes('Archiv-Pull unvollständig'), 'notes are kept');
  assert.match(final, /📝 \*\*Zusammenfassung:\*\* Die Gruppe .* … \(vollständig: summary\.md im Archiv\)$/s);

  // Short paths: the recap keeps its usual 1100 chars.
  const short = finalizeResultText({ ...result, transcriptPath: '/data/t.md', archiveDir: '/data/a' }, '', { maxChars: 1900 });
  assert.equal(short.split('📝 **Zusammenfassung:** ')[1], `${result.summary.slice(0, 1100).trimEnd()} … (vollständig: summary.md im Archiv)`);
  // A short recap is shown whole; no recap → no line.
  assert.match(finalizeResultText({ ...result, summary: 'Kurz.' }, ''), /📝 \*\*Zusammenfassung:\*\* Kurz\.$/);
  assert.ok(!finalizeResultText({ ...result, summary: null }, '').includes('Zusammenfassung'));
  // Any oversized text (e.g. a long error) is clamped rather than rejected.
  await s.fail('x'.repeat(5000));
  assert.ok(ch.log.at(-1)[1].length <= 2000);
});
