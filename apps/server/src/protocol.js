// Binärprotokoll für 20 ms Frames
// magic(4)='UPLK'|'DNLK' | ver(1)=1 | flags(1):bit0 codec(0=pcm,1=opus) | rsv(2)
// sessionId(8 u64) | userId(8 u64) | seq(4 u32) | ts_ms(8 u64) | len(2 u16) | payload(len)

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
  writeU64(hdr, o, sessionId); o += 8;
  writeU64(hdr, o, userId); o += 8;
  hdr.writeUInt32BE(seq >>> 0, o); o += 4;
  writeU64(hdr, o, BigInt(tsMs)); o += 8;
  hdr.writeUInt16BE(payload.length, o); o += 2;
  return Buffer.concat([hdr, payload]);
}

// Header is fixed-size: 4+1+1+2+8+8+4+8+2 = 38 bytes.
const HEADER_SIZE = 38;
const MAX_PAYLOAD = 4000; // Opus 120ms @ 510kbps ≈ 7650 bits, 20ms frames are far smaller.

export function parseFrame(buf) {
  if (buf.length < HEADER_SIZE) throw new Error(`frame too short: ${buf.length} < ${HEADER_SIZE}`);
  let o = 0;
  const magic = buf.subarray(0, 4); o += 4;
  if (!magic.equals(MAGIC_UPLK) && !magic.equals(MAGIC_DNLK)) {
    throw new Error(`bad magic: ${magic.toString('hex')}`);
  }
  const ver = buf.readUInt8(o); o += 1;
  if (ver !== VER) throw new Error(`version mismatch: ${ver} != ${VER}`);
  const flags = buf.readUInt8(o); o += 1;
  o += 2; // rsv
  const sessionId = readU64(buf, o); o += 8;
  const userId = readU64(buf, o); o += 8;
  const seq = buf.readUInt32BE(o); o += 4;
  const tsMs = Number(readU64(buf, o)); o += 8;
  const len = buf.readUInt16BE(o); o += 2;
  if (len > MAX_PAYLOAD) throw new Error(`payload too large: ${len} > ${MAX_PAYLOAD}`);
  if (buf.length < o + len) throw new Error(`payload truncated: have ${buf.length - o} need ${len}`);
  const payload = buf.subarray(o, o + len);
  const codec = (flags & 1) ? 'opus' : 'pcm';
  return { magic, codec, sessionId, userId, seq, tsMs, payload };
}

export function writeU64(b, off, v) {
  const n = BigInt(v);
  b.writeBigUInt64BE(n, off);
}
export function readU64(b, off) {
  return b.readBigUInt64BE(off);
}
