import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinalizeStatus, formatProgress } from '../src/finalizeStatus.js';

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
