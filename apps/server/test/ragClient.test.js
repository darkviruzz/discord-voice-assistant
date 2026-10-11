import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { queryRag, ragEnabled, ragConfig, _resetState } from '../src/ragClient.js';

const ENV_KEYS = ['RAG_URL', 'RAG_TIMEOUT_MS', 'RAG_SCORE_THRESHOLD'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetState();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Start a one-off HTTP server; `handler(reqBody, res, req)` answers each
// request. Every request is recorded in `reqs` ({ url, method, body }) so the
// test asserts on it after the call — an assertion thrown inside the handler
// would only surface as an unrelated timeout.
function withServer(handler, fn) {
  const reqs = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        reqs.push({ url: req.url, method: req.method, body: parsed });
        handler(parsed, res, req);
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.RAG_URL = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn(reqs)); }
      catch (e) { reject(e); }
      finally { server.closeAllConnections(); server.close(); }
    });
  });
}

const json = (payload, status = 200) => (_body, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

// Capture console.warn/log lines emitted by the logger during `fn`.
async function captureLogs(fn) {
  const lines = { warn: [], info: [] };
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a) => { lines.warn.push(a.join(' ')); };
  console.log = (...a) => { lines.info.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = origWarn; console.log = origLog; }
  return lines;
}

test('returns "" and is disabled when RAG_URL is unset, empty or whitespace', async () => {
  for (const v of [undefined, '', '   ']) {
    if (v === undefined) delete process.env.RAG_URL; else process.env.RAG_URL = v;
    assert.equal(ragEnabled(), false, `RAG_URL=${JSON.stringify(v)}`);
    assert.equal(await queryRag('wer ist Baron Kelthur?'), '');
    assert.equal(ragConfig().url, null);
  }
});

test('returns "" for an empty query without calling the service', async () => {
  await withServer(json([{ text: 'x', source: 'x.md' }]), async (reqs) => {
    assert.equal(await queryRag('   '), '');
    assert.equal(await queryRag(null), '');
    assert.equal(reqs.length, 0);
  });
});

test('POSTs {query, top_k} to /query and formats chunks with their source', async () => {
  await withServer(json([
    { text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md', distance: 0.21 },
    { text: '', source: 'leer.md' }, // dropped (blank)
    { text: 'Greyhawk liegt im Norden.', source: 'orte.md', distance: 0.4 },
  ]), async (reqs) => {
    const out = await queryRag('  Greyhawk  ');
    assert.equal(out,
      '[Quelle: npcs/kelthur.md]\nBaron Kelthur herrscht.\n\n[Quelle: orte.md]\nGreyhawk liegt im Norden.');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].method, 'POST');
    assert.equal(reqs[0].url, '/query');
    assert.deepEqual(reqs[0].body, { query: 'Greyhawk', top_k: 3 });
  });
});

test('normalizes RAG_URL (surrounding whitespace, trailing slashes)', async () => {
  await withServer(json([{ text: 'Treffer.', source: 'a.md' }]), async (reqs) => {
    process.env.RAG_URL = `  ${process.env.RAG_URL}//  `;
    assert.equal(ragEnabled(), true);
    assert.equal(await queryRag('x'), '[Quelle: a.md]\nTreffer.');
    assert.equal(reqs[0].url, '/query');
    assert.ok(!ragConfig().url.endsWith('/'));
  });
});

test('accepts the {results: [...]} envelope too', async () => {
  await withServer(json({ results: [{ text: 'Eingepackt.', source: 'e.md' }] }), async () => {
    assert.equal(await queryRag('x'), '[Quelle: e.md]\nEingepackt.');
  });
});

test('empty hit list → ""', async () => {
  await withServer(json([]), async () => {
    assert.equal(await queryRag('x'), '');
  });
});

test('clamps top_k to the service contract (1..20, integer)', async () => {
  await withServer(json([]), async (reqs) => {
    await queryRag('x', 50);
    await queryRag('x', 2.7);
    await queryRag('x', 0);
    await queryRag('x', 'abc');
    assert.deepEqual(reqs.map((r) => r.body.top_k), [20, 2, 3, 3]);
  });
});

test('degrades to "" on HTTP error', async () => {
  await withServer((_body, res) => {
    res.writeHead(500);
    res.end('boom');
  }, async () => {
    assert.equal(await queryRag('x'), '');
  });
});

test('degrades to "" on malformed JSON', async () => {
  await withServer(json('[{"text": "abgeschnitten'), async () => {
    assert.equal(await queryRag('x'), '');
  });
});

test('degrades to "" on an unexpected JSON shape (e.g. a FastAPI error object)', async () => {
  await withServer(json({ detail: 'kaputt' }), async () => {
    assert.equal(await queryRag('x'), '');
  });
  await withServer(json(null), async () => {
    assert.equal(await queryRag('x'), '');
  });
});

test('degrades to "" when the service is down (connection refused)', async () => {
  process.env.RAG_URL = 'http://127.0.0.1:1';
  assert.equal(await queryRag('x'), '');
});

test('degrades to "" on timeout (no response headers)', async () => {
  process.env.RAG_TIMEOUT_MS = '50';
  await withServer((_body, res) => {
    // Never respond within the timeout window.
    setTimeout(() => { res.writeHead(200); res.end('[]'); }, 500);
  }, async () => {
    const t0 = Date.now();
    assert.equal(await queryRag('x'), '');
    assert.ok(Date.now() - t0 < 400, 'aborted well before the slow response');
  });
});

test('the timeout also bounds a body that stalls after the headers', async () => {
  process.env.RAG_TIMEOUT_MS = '80';
  await withServer((_body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[{"text": "halb');
    // ...and never finish the body.
  }, async () => {
    const t0 = Date.now();
    assert.equal(await queryRag('x'), '');
    assert.ok(Date.now() - t0 < 1000, `bounded by RAG_TIMEOUT_MS (took ${Date.now() - t0} ms)`);
  });
});

test('falls back to the 800 ms default for invalid/zero/negative/overflowing RAG_TIMEOUT_MS', () => {
  for (const v of ['abc', '0', '-5', '']) {
    process.env.RAG_TIMEOUT_MS = v;
    assert.equal(ragConfig().timeoutMs, 800, `RAG_TIMEOUT_MS=${JSON.stringify(v)}`);
  }
  // Beyond setTimeout's 32-bit range Node would fire after 1 ms — clamp instead.
  process.env.RAG_TIMEOUT_MS = '5000000000';
  assert.equal(ragConfig().timeoutMs, 2_147_483_647);
});

test('a per-call timeoutMs overrides RAG_TIMEOUT_MS', async () => {
  process.env.RAG_TIMEOUT_MS = '30';
  await withServer((_body, res) => {
    setTimeout(json([{ text: 'Spät, aber da.', source: 's.md' }]).bind(null, null, res), 150);
  }, async () => {
    assert.equal(await queryRag('x'), '', 'hot-path budget is exceeded');
    assert.equal(await queryRag('x', 3, { timeoutMs: 2000 }), '[Quelle: s.md]\nSpät, aber da.');
  });
});

test('warns once when RAG starts failing and logs once when it recovers', async () => {
  let fail = true;
  await withServer((body, res) => {
    if (fail) { res.writeHead(503); res.end('nope'); return; }
    json([{ text: 'ok', source: 'ok.md' }])(body, res);
  }, async () => {
    const lines = await captureLogs(async () => {
      await queryRag('a');
      await queryRag('b');
      await queryRag('c');
      fail = false;
      await queryRag('d');
      await queryRag('e');
    });
    const ragWarns = lines.warn.filter((l) => l.includes('ragClient'));
    assert.equal(ragWarns.length, 1, `one warning for a failure streak, got: ${ragWarns.join(' | ')}`);
    assert.match(ragWarns[0], /HTTP 503/);
    assert.equal(lines.info.filter((l) => l.includes('RAG reachable again')).length, 1);
  });
});

test('sends score_threshold in the body when RAG_SCORE_THRESHOLD is set', async () => {
  process.env.RAG_SCORE_THRESHOLD = '0.75';
  await withServer(json([]), async (reqs) => {
    await queryRag('Greyhawk');
    assert.equal(reqs[0].body.score_threshold, 0.75);
    assert.equal(ragConfig().scoreThreshold, 0.75);
  });
});

test('sends score_threshold 0 (a valid, if strict, filter)', async () => {
  process.env.RAG_SCORE_THRESHOLD = '0';
  await withServer(json([]), async (reqs) => {
    await queryRag('Greyhawk');
    assert.equal(reqs[0].body.score_threshold, 0);
  });
});

for (const [label, value] of [
  ['unset', undefined], ['empty', '   '], ['not a number', 'abc'], ['negative', '-1'],
]) {
  test(`omits score_threshold when RAG_SCORE_THRESHOLD is ${label}`, async () => {
    if (value !== undefined) process.env.RAG_SCORE_THRESHOLD = value;
    await withServer(json([]), async (reqs) => {
      await queryRag('Greyhawk');
      assert.equal('score_threshold' in reqs[0].body, false);
      assert.equal(ragConfig().scoreThreshold, null);
    });
  });
}
