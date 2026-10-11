import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBearer, pickProtocolFor } from '../src/auth.js';

// checkBearer guards /uplink, /control and every /finalize/* HTTP route.
const req = (headers) => ({ headers });
const TOKEN = 's3cr3t-token';

test('checkBearer: exact "Authorization: Bearer <token>" is accepted', () => {
  assert.equal(checkBearer(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), true);
});

test('checkBearer: near-misses of the Authorization header are rejected', () => {
  for (const h of [
    `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, `Bearer  ${TOKEN}`,
    `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN} `, '', 'Bearer ',
  ]) {
    assert.equal(checkBearer(req({ authorization: h }), TOKEN), false, JSON.stringify(h));
  }
  assert.equal(checkBearer(req({}), TOKEN), false, 'no header');
  assert.equal(checkBearer(req({ authorization: [`Bearer ${TOKEN}`] }), TOKEN), false, 'non-string header');
});

test('checkBearer: Sec-WebSocket-Protocol must contain the token as an exact list entry', () => {
  assert.equal(checkBearer(req({ 'sec-websocket-protocol': TOKEN }), TOKEN), true);
  assert.equal(checkBearer(req({ 'sec-websocket-protocol': `v1, ${TOKEN} ,json` }), TOKEN), true);
  for (const p of [`${TOKEN}x`, `x${TOKEN}`, `v1,${TOKEN.toUpperCase()}`, `${TOKEN.slice(0, 4)}, ${TOKEN.slice(4)}`, '']) {
    assert.equal(checkBearer(req({ 'sec-websocket-protocol': p }), TOKEN), false, `substring/variant ${JSON.stringify(p)}`);
  }
});

test('checkBearer: with no bearer configured every request passes (documented open mode)', () => {
  // NOTE: this is fail-open — an unset CONTROL_BEARER disables auth on the
  // uplink/control sockets and the finalize upload/archive routes.
  assert.equal(checkBearer(req({}), undefined), true);
  assert.equal(checkBearer(req({}), ''), true);
});

test('pickProtocolFor echoes only the configured bearer subprotocol', () => {
  const pick = pickProtocolFor(TOKEN);
  assert.equal(pick(new Set(['v1', TOKEN])), TOKEN);
  assert.equal(pick(['v1', TOKEN]), TOKEN);
  assert.equal(pick(new Set(['v1', `${TOKEN}x`])), false);
  assert.equal(pickProtocolFor('')(new Set([''])), false, 'no bearer → never echo');
  assert.equal(pickProtocolFor(undefined)(new Set(['x'])), false);
});
