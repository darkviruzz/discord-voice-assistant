import fs from 'fs';
import path from 'path';

// File-system helpers that keep state files intact when the disk is full.
//
// No logger.js import on purpose: configOverrides.js uses this and runs before
// logger.js may be loaded (see bootConfig.js).

let _seq = 0;

// Write a file so that it is either fully replaced or left exactly as it was.
// fs.writeFileSync truncates first and then writes; on a full disk (ZFS
// refquota → EDQUOT, "Unknown system error -122") that left session.json cut
// off mid-JSON and config.overrides.json empty. Here the new content goes to a
// temp file next to the target and is renamed over it only once it is
// complete; a failed write removes the temp file and rethrows.
export function writeFileAtomic(fp, data) {
  const tmp = path.join(path.dirname(fp), `.${path.basename(fp)}.tmp-${process.pid}-${++_seq}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

// ENOSPC (disk full) or EDQUOT (quota exceeded — what a full Proxmox LXC on
// ZFS reports). Node has no name for errno -122 and reports it as
// "Unknown system error -122".
export function isDiskFullError(e) {
  if (!e) return false;
  if (e.code === 'ENOSPC' || e.code === 'EDQUOT') return true;
  if (e.errno === -28 || e.errno === -122) return true;
  return /system error -122\b/.test(String(e.message || ''));
}

// Human-readable error text for Discord messages and logs.
export function describeError(e) {
  if (isDiskFullError(e)) {
    return `💾 Speicher auf dem Bot-Host voll${e.path ? ` (beim Schreiben von \`${e.path}\`)` : ''}. Platz schaffen, dann erneut versuchen.`;
  }
  return String(e?.message ?? e);
}
