import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;

// Returns "<package.json version>-<short git hash>", e.g. "1.0.1-d5b717a".
// Falls back to just the package version if git is unavailable.
export function getVersion() {
  if (cached !== null) return cached;

  let pkgVersion = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    if (pkg.version) pkgVersion = pkg.version;
  } catch {}

  let gitHash = '';
  try {
    gitHash = execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).toString().trim();
  } catch {}

  cached = gitHash ? `${pkgVersion}-${gitHash}` : pkgVersion;
  return cached;
}
