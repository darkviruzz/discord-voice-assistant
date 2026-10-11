import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTranscriptAuth } from '../src/transcriptAuth.js';

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
}
function run(mw, authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { nexted, res };
}
function basic(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

afterEach(() => {
  delete process.env.TRANSCRIPT_UI_AUTH;
  delete process.env.TRANSCRIPT_UI_USER;
  delete process.env.TRANSCRIPT_UI_PASS;
});

test('auth is on by default with greyhawk/greyhawk', () => {
  const mw = makeTranscriptAuth();
  assert.ok(mw, 'middleware present by default');
  assert.equal(run(mw, basic('greyhawk', 'greyhawk')).nexted, true);
});

test('rejects missing / wrong credentials with 401 + WWW-Authenticate', () => {
  const mw = makeTranscriptAuth();
  const none = run(mw, null);
  assert.equal(none.nexted, false);
  assert.equal(none.res.statusCode, 401);
  assert.match(none.res.headers['WWW-Authenticate'], /^Basic realm=/);

  const wrong = run(mw, basic('greyhawk', 'nope'));
  assert.equal(wrong.nexted, false);
  assert.equal(wrong.res.statusCode, 401);
});

test('honors custom credentials from env', () => {
  process.env.TRANSCRIPT_UI_USER = 'dm';
  process.env.TRANSCRIPT_UI_PASS = 's3cret';
  const mw = makeTranscriptAuth();
  assert.equal(run(mw, basic('dm', 's3cret')).nexted, true);
  assert.equal(run(mw, basic('greyhawk', 'greyhawk')).nexted, false);
});

test('TRANSCRIPT_UI_AUTH=off disables auth entirely', () => {
  process.env.TRANSCRIPT_UI_AUTH = 'off';
  assert.equal(makeTranscriptAuth(), null);
});

test('rejects malformed or foreign Authorization headers', () => {
  const mw = makeTranscriptAuth();
  const b64 = (str) => Buffer.from(str).toString('base64');
  for (const h of [
    'Bearer greyhawk', 'Basic', 'Basic ', `Basic ${b64('greyhawk')}` /* no colon */,
    `Basic ${b64('greyhawk:greyhawk ')}`, `Basic ${b64('Greyhawk:greyhawk')}`, `Basic ${b64(':greyhawk')}`,
    `Digest ${b64('greyhawk:greyhawk')}`,
  ]) {
    const r = run(mw, h);
    assert.equal(r.nexted, false, h);
    assert.equal(r.res.statusCode, 401, h);
  }
});

test('password may contain ":" (split at the first colon); the scheme is case-insensitive', () => {
  process.env.TRANSCRIPT_UI_PASS = 'a:b:c';
  const mw = makeTranscriptAuth();
  assert.equal(run(mw, basic('greyhawk', 'a:b:c')).nexted, true);
  assert.equal(run(mw, 'basic ' + Buffer.from('greyhawk:a:b:c').toString('base64')).nexted, true);
  assert.equal(run(mw, basic('greyhawk', 'a:b')).nexted, false);
});

test('credentials are read per request, so a changed password applies without a restart', () => {
  const mw = makeTranscriptAuth();
  assert.equal(run(mw, basic('greyhawk', 'greyhawk')).nexted, true);
  process.env.TRANSCRIPT_UI_PASS = 'neu';
  assert.equal(run(mw, basic('greyhawk', 'greyhawk')).nexted, false, 'old password stops working');
  assert.equal(run(mw, basic('greyhawk', 'neu')).nexted, true);
});

test('TRANSCRIPT_UI_AUTH: off/none/false/0 (any case) disable auth; anything else keeps it on', () => {
  for (const v of ['off', 'OFF', 'None', 'false', '0']) {
    process.env.TRANSCRIPT_UI_AUTH = v;
    assert.equal(makeTranscriptAuth(), null, v);
  }
  for (const v of ['basic', 'on', 'yes', '']) {
    process.env.TRANSCRIPT_UI_AUTH = v;
    assert.equal(typeof makeTranscriptAuth(), 'function', JSON.stringify(v));
  }
});
