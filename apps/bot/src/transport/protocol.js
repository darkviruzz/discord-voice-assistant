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

function writeU64(b, off, v) {
  b.writeBigUInt64BE(BigInt(v), off);
}
