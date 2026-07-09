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
