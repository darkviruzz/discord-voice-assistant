import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerHolds } from '../src/answerHolds.js';
import { LinkKeeper } from '../src/transport/linkKeeper.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /ask outside a voice session: the link is opened on demand and the idle
// release armed (grace). Without a hold, an answer slower than the grace
// arrived after the link was dropped — broadcast to nobody, lost.
test('the link stays up until the answer for that channel arrives, then the idle policy applies', async () => {
  let released = 0;
  const keeper = new LinkKeeper({ release: () => { released++; }, graceMs: 30 });
  const holds = new AnswerHolds({ hold: (r) => keeper.hold(r), timeoutMs: 1000 });
  holds.add('c1');
  keeper.scheduleRelease(); // maybeScheduleIdleRelease() right after the ask
  await sleep(60);
  assert.equal(released, 0, 'grace passed, but the answer is still pending');
  holds.settle('other'); // another channel's answer does not free this one
  await sleep(60);
  assert.equal(released, 0);
  holds.settle('c1');
  assert.equal(holds.size, 0);
  await sleep(60);
  assert.equal(released, 1, 'released after the grace once answered');
});

test('one hold per question, oldest first; an unanswered question is released on timeout', async () => {
  const log = [];
  const holds = new AnswerHolds({ hold: (r) => { log.push(`+${r}`); return () => log.push(`-${r}`); }, timeoutMs: 40 });
  holds.add('c1');
  holds.add('c1');
  assert.equal(holds.size, 2);
  holds.settle('c1');
  assert.deepEqual(log, ['+answer c1', '+answer c1', '-answer c1']);
  await sleep(80);
  assert.deepEqual(log.slice(-1), ['-answer c1'], 'second hold timed out');
  assert.equal(holds.size, 0);
  holds.settle('c1'); // nothing pending → no-op
  assert.equal(log.length, 4);
});
