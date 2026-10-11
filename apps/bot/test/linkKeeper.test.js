import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LinkKeeper } from '../src/transport/linkKeeper.js';

// Idle-release policy of the on-demand control link (transport/index.js wires
// `release` to disconnect()). Short grace periods keep the tests fast.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeKeeper({ hasWork = () => false, graceMs = 30 } = {}) {
  const calls = { released: 0 };
  const keeper = new LinkKeeper({ release: () => { calls.released++; }, hasWork, graceMs });
  return { keeper, calls };
}

test('without holds or work the link is released after the grace period', async () => {
  const { keeper, calls } = makeKeeper();
  keeper.scheduleRelease({ delayMs: 20 });
  await sleep(10);
  assert.equal(calls.released, 0, 'not before the grace period');
  await sleep(30);
  assert.equal(calls.released, 1);
});

test('hasWork() at fire time keeps the link (e.g. /join during the grace window)', async () => {
  let active = false;
  const { keeper, calls } = makeKeeper();
  keeper.scheduleRelease({ delayMs: 20, hasWork: () => active });
  active = true;
  await sleep(40);
  assert.equal(calls.released, 0);
});

test('a hold (finalize after /leave) outlives the idle release armed by /leave', async () => {
  const { keeper, calls } = makeKeeper({ graceMs: 20 });
  keeper.scheduleRelease({ delayMs: 20 });           // /leave
  const release = keeper.hold('finalize s1');        // /finalize run
  assert.equal(keeper.isHeld(), true);
  keeper.scheduleRelease({ delayMs: 10 });           // e.g. an /ask re-arms it mid-finalize
  await sleep(60);                                   // finalize runs far beyond the grace period
  assert.equal(calls.released, 0, 'link kept while the finalize holds it');

  release();                                         // finalize done
  assert.equal(keeper.isHeld(), false);
  assert.equal(calls.released, 0, 'not dropped instantly — grace period first');
  await sleep(40);
  assert.equal(calls.released, 1, 'last release re-applied the idle policy');
});

test('releasing the last hold does not arm a release while a session is active', async () => {
  let active = true;
  const { keeper, calls } = makeKeeper({ hasWork: () => active, graceMs: 10 });
  const release = keeper.hold('finalize');
  release();
  await sleep(30);
  assert.equal(calls.released, 0, 'still in voice → link stays');
  active = false;
  await sleep(30);
  assert.equal(calls.released, 0, 'nothing armed behind the caller’s back; the next detach arms it');
});

test('only the LAST hold re-arms; release functions are idempotent', async () => {
  const { keeper, calls } = makeKeeper({ graceMs: 10 });
  const r1 = keeper.hold('a');
  const r2 = keeper.hold('b');
  r1();
  r1(); // double release must not drop hold b
  assert.equal(keeper.isHeld(), true);
  await sleep(30);
  assert.equal(calls.released, 0);
  r2();
  await sleep(30);
  assert.equal(calls.released, 1);
});

test('cancelRelease() (connect/disconnect) cancels a pending release', async () => {
  const { keeper, calls } = makeKeeper();
  keeper.scheduleRelease({ delayMs: 10 });
  keeper.cancelRelease();
  await sleep(30);
  assert.equal(calls.released, 0);
});
