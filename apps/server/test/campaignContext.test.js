import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCampaignContext, _resetCache } from '../src/campaignContext.js';

let tmpDir;
let savedEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-'));
  savedEnv = {
    LIVE_CONTEXT_ENABLED: process.env.LIVE_CONTEXT_ENABLED,
    CAMPAIGN_CONTEXT_FILE: process.env.CAMPAIGN_CONTEXT_FILE,
    CAMPAIGN_CONTEXT_MAX_CHARS: process.env.CAMPAIGN_CONTEXT_MAX_CHARS,
    OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
  };
  delete process.env.LIVE_CONTEXT_ENABLED;
  delete process.env.CAMPAIGN_CONTEXT_MAX_CHARS;
  delete process.env.OBSIDIAN_VAULT_PATH;
  _resetCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetCache();
});

function writeContext(content) {
  const fp = path.join(tmpDir, 'CAMPAIGN.md');
  fs.writeFileSync(fp, content, 'utf8');
  process.env.CAMPAIGN_CONTEXT_FILE = fp; // absolute → no vault root needed
  return fp;
}

test('returns file content when present', () => {
  writeContext('Baron Kelthur herrscht über Greyhawk.');
  assert.equal(getCampaignContext(), 'Baron Kelthur herrscht über Greyhawk.');
});

test('returns empty string when file is missing', () => {
  process.env.CAMPAIGN_CONTEXT_FILE = path.join(tmpDir, 'does-not-exist.md');
  assert.equal(getCampaignContext(), '');
});

test('returns empty string when disabled', () => {
  writeContext('egal');
  process.env.LIVE_CONTEXT_ENABLED = 'false';
  assert.equal(getCampaignContext(), '');
});

test('relative file with no vault root → disabled (empty)', () => {
  process.env.CAMPAIGN_CONTEXT_FILE = 'CAMPAIGN.md';
  delete process.env.OBSIDIAN_VAULT_PATH;
  assert.equal(getCampaignContext(), '');
});

test('resolves relative file against OBSIDIAN_VAULT_PATH', () => {
  fs.writeFileSync(path.join(tmpDir, 'CAMPAIGN.md'), 'Aus dem Vault.', 'utf8');
  process.env.OBSIDIAN_VAULT_PATH = tmpDir;
  process.env.CAMPAIGN_CONTEXT_FILE = 'CAMPAIGN.md';
  assert.equal(getCampaignContext(), 'Aus dem Vault.');
});

test('truncates to CAMPAIGN_CONTEXT_MAX_CHARS, keeping the front', () => {
  const long = 'A'.repeat(100) + '\n' + 'B'.repeat(100);
  writeContext(long);
  process.env.CAMPAIGN_CONTEXT_MAX_CHARS = '50';
  const out = getCampaignContext();
  assert.ok(out.length <= 50);
  assert.ok(out.startsWith('A'), 'keeps the front of the file');
});

test('caches across calls and refreshes on mtime change', () => {
  const fp = writeContext('Version eins.');
  assert.equal(getCampaignContext(), 'Version eins.');
  // Rewrite with a bumped mtime so the cache invalidates.
  fs.writeFileSync(fp, 'Version zwei.', 'utf8');
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(fp, future, future);
  assert.equal(getCampaignContext(), 'Version zwei.');
});
