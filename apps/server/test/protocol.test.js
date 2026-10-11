import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, parseFrame, MAGIC_UPLK, MAGIC_DNLK } from '../src/protocol.js';

// Binary 20 ms frame format shared with the bot (uplink audio from Discord).
// Fixed 38-byte header + payload; parseFrame is the server's input validator.
const HEADER = 38;

const base = () => ({
  magic: MAGIC_UPLK,
  codec: 'opus',
  sessionId: 1_780_058_709_544n,
  userId: 696665320185659453n, // Discord snowflake > 2^53: must survive as BigInt
  seq: 42,
  tsMs: 1_780_059_282_375,
  payload: Buffer.from([0xf8, 0xff, 0xfe, 0x00, 0x01]),
});

test('buildFrame → parseFrame round-trips every field (u64 ids stay exact)', () => {
  const f = buildFrame(base());
  assert.equal(f.length, HEADER + 5);
  const p = parseFrame(f);
  assert.ok(p.magic.equals(MAGIC_UPLK));
  assert.equal(p.codec, 'opus');
  assert.equal(p.sessionId, 1_780_058_709_544n);
  assert.equal(p.userId, 696665320185659453n);
  assert.equal(p.seq, 42);
  assert.equal(p.tsMs, 1_780_059_282_375);
  assert.ok(p.payload.equals(base().payload));
});

test('codec flag, DNLK magic, seq wrap-around and empty payload', () => {
  const p = parseFrame(buildFrame({ ...base(), magic: MAGIC_DNLK, codec: 'pcm', seq: 2 ** 32 + 7, payload: Buffer.alloc(0) }));
  assert.ok(p.magic.equals(MAGIC_DNLK));
  assert.equal(p.codec, 'pcm');
  assert.equal(p.seq, 7, 'seq is u32 (wraps)');
  assert.equal(p.payload.length, 0);
});

test('trailing bytes after the declared payload are ignored', () => {
  const f = Buffer.concat([buildFrame(base()), Buffer.from('garbage')]);
  assert.equal(parseFrame(f).payload.length, 5);
});

test('parseFrame rejects short, foreign, wrong-version, truncated and oversized frames', () => {
  const good = buildFrame(base());
  assert.throws(() => parseFrame(good.subarray(0, HEADER - 1)), /frame too short/);

  const badMagic = Buffer.from(good); badMagic.write('XXXX', 0);
  assert.throws(() => parseFrame(badMagic), /bad magic/);

  const badVer = Buffer.from(good); badVer.writeUInt8(2, 4);
  assert.throws(() => parseFrame(badVer), /version mismatch/);

  assert.throws(() => parseFrame(good.subarray(0, good.length - 1)), /payload truncated/);

  const huge = Buffer.from(good); huge.writeUInt16BE(4001, HEADER - 2);
  assert.throws(() => parseFrame(huge), /payload too large/);
  const max = Buffer.concat([good.subarray(0, HEADER), Buffer.alloc(4000)]); max.writeUInt16BE(4000, HEADER - 2);
  assert.equal(parseFrame(max).payload.length, 4000, '4000 bytes is still allowed');
});
