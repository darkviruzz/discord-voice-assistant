// Mirror of apps/server/src/protocol.js — same binary wire format.
// Kept as a local copy to avoid introducing a shared workspace package; if a
// third consumer appears, extract to packages/protocol.

export const MAGIC_UPLK = Buffer.from('UPLK');
export const MAGIC_DNLK = Buffer.from('DNLK');
const VER = 1;

export function buildFrame({ magic, codec, sessionId, userId, seq, tsMs, payload }) {
  const flags = codec === 'opus' ? 1 : 0;
  const hdr = Buffer.alloc(4 + 1 + 1 + 2 + 8 + 8 + 4 + 8 + 2);
  let o = 0;
  magic.copy(hdr, o); o += 4;
  hdr.writeUInt8(VER, o); o += 1;
  hdr.writeUInt8(flags, o); o += 1;
  hdr.writeUInt16BE(0, o); o += 2;
  writeU64(hdr, o, BigInt(sessionId)); o += 8;
  writeU64(hdr, o, BigInt(userId)); o += 8;
  hdr.writeUInt32BE(seq >>> 0, o); o += 4;
  writeU64(hdr, o, BigInt(tsMs)); o += 8;
  hdr.writeUInt16BE(payload.length, o); o += 2;
  return Buffer.concat([hdr, payload]);
}

const HEADER_SIZE = 38;
const MAX_PAYLOAD  = 4000;

export function parseFrame(buf) {
  if (buf.length < HEADER_SIZE) throw new Error(`frame too short: ${buf.length}`);
  let o = 0;
  const magic = buf.subarray(0, 4); o += 4;
  if (!magic.equals(MAGIC_UPLK) && !magic.equals(MAGIC_DNLK)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  const ver = buf.readUInt8(o); o += 1;
  if (ver !== VER) throw new Error(`version mismatch: ${ver}`);
  const flags = buf.readUInt8(o); o += 1;
  o += 2; // rsv
  const sessionId = buf.readBigUInt64BE(o); o += 8;
  const userId    = buf.readBigUInt64BE(o); o += 8;
  const seq       = buf.readUInt32BE(o);    o += 4;
  const tsMs      = Number(buf.readBigUInt64BE(o)); o += 8;
  const len       = buf.readUInt16BE(o);    o += 2;
  if (len > MAX_PAYLOAD) throw new Error(`payload too large: ${len}`);
  if (buf.length < o + len) throw new Error(`payload truncated`);
  const payload = buf.subarray(o, o + len);
  const codec = (flags & 1) ? 'opus' : 'pcm';
  return { magic, codec, sessionId, userId, seq, tsMs, payload };
}

function writeU64(b, off, v) {
  b.writeBigUInt64BE(BigInt(v), off);
}
