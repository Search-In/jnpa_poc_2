/**
 * UC-3 gateway live source for the reference-data ingest (Node-only, build-time).
 *
 * Implements the "file source can be swapped for a live feed" promise in
 * scripts/ingest-reference/index.mjs: instead of walking the local reference
 * package, the shipping-line CSV set is pulled from the jnpa-uc3-poc gateway's
 * file API and fed to THE SAME pure transforms (@jnpa/data parseShiplineCsv).
 * No parsing happens here — this module only sources bytes.
 *
 * Gateway contract (jnpa-uc3-poc):
 *   POST {GATEWAY}/api/auth/login {"username","password"} -> {"access_token"}   (8h JWT)
 *   GET  {GATEWAY}/api/jnpa/files?group=shipping-lines&limit=500  (Bearer)
 *        -> {"items":[{"sha256","filename","group","message_type",...}],"count"}
 *   GET  {GATEWAY}/api/jnpa/files/{sha256}                        (Bearer)
 *        -> raw bytes, Content-Disposition: attachment; filename="<original>"
 *
 * Environment:
 *   UC3_GATEWAY_URL  gateway base URL   (default http://localhost:8000)
 *   UC3_USERNAME     login username     (optional — dev mode may run with auth
 *   UC3_PASSWORD     login password      disabled; when unset, login is skipped
 *                                        and requests are sent without a token)
 *
 * Uses only Node built-ins (global fetch, node:http for the self-test); adds no
 * dependencies. Self-test (stub gateway on an ephemeral port, no network):
 *   node scripts/ingest-reference/gateway-source.mjs --selftest
 */
import { fileURLToPath } from 'node:url';

/** Gateway base URL from env (trailing slashes stripped). Read at call time so
 * tests and callers may set env after import. */
function gatewayBase() {
  return (process.env.UC3_GATEWAY_URL || 'http://localhost:8000').replace(/\/+$/, '');
}

/** Bearer header for `token`, or no auth header at all when token is null
 * (dev-mode gateway with auth disabled). */
function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Log in to the gateway and return the access token, or null when
 * UC3_USERNAME/UC3_PASSWORD are unset (dev-mode: auth disabled, no token
 * needed — the caller then sends unauthenticated requests). Throws when
 * credentials ARE provided but the login call fails: a wrong password must
 * surface loudly, not degrade into anonymous requests.
 */
export async function login() {
  const username = process.env.UC3_USERNAME;
  const password = process.env.UC3_PASSWORD;
  if (!username || !password) return null;

  const res = await fetch(`${gatewayBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`gateway login failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error('gateway login succeeded but returned no access_token');
  }
  return body.access_token;
}

/**
 * List the gateway's shipping-line CSV files. Server-side the query is already
 * scoped with ?group=shipping-lines, but the result is defensively re-filtered
 * client-side to `group === 'shipping-lines'` AND `filename` ending in .csv
 * (the group can also hold non-CSV artifacts; only CSVs feed parseShiplineCsv).
 * Returns the raw listing items ({sha256, filename, group, ...}).
 */
export async function listShiplineFiles(token = null) {
  const res = await fetch(`${gatewayBase()}/api/jnpa/files?group=shipping-lines&limit=500`, {
    headers: { Accept: 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    throw new Error(`gateway file listing failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.filter(
    (it) =>
      it &&
      typeof it.filename === 'string' &&
      it.filename.toLowerCase().endsWith('.csv') &&
      it.group === 'shipping-lines',
  );
}

/** Extract the original filename from a Content-Disposition header value.
 * Handles the RFC 5987 `filename*=UTF-8''...` form (preferred when present)
 * and the plain `filename="..."` / `filename=...` forms. Returns null when
 * absent. */
export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  if (plain) return (plain[1] ?? plain[2]).trim();
  return null;
}

/**
 * Fetch one file's bytes from the gateway by content hash and return
 * `{ filename, text }` — filename from the Content-Disposition attachment
 * header (falling back to the sha256 when the header is absent), text as
 * UTF-8. The caller decides IAL/EAL from the filename, exactly as the
 * file-walk path decides it from the directory name.
 */
export async function fetchFileText(sha256, token = null) {
  const res = await fetch(`${gatewayBase()}/api/jnpa/files/${sha256}`, {
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    throw new Error(`gateway file fetch failed for ${sha256}: HTTP ${res.status} ${res.statusText}`);
  }
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition')) || sha256;
  const text = await res.text();
  return { filename, text };
}

/* ------------------------------------------------------------------------- *
 * Self-test: `node gateway-source.mjs --selftest`
 * Boots a stub gateway (node:http, ephemeral port) and proves:
 *   1. login-optional flow — no creds: login() returns null, no /api/auth/login
 *      call is made, requests carry NO Authorization header;
 *   2. login flow — creds set: login() posts them, returns the token, and
 *      subsequent requests carry the Bearer header;
 *   3. list filtering — non-CSV and non-shipping-lines items are dropped;
 *   4. filename extraction — Content-Disposition (quoted and RFC 5987 forms)
 *      wins, sha256 is the fallback, body text round-trips.
 * ------------------------------------------------------------------------- */
async function selftest() {
  const { createServer } = await import('node:http');

  const CSV_TEXT = 'Container,ISO,Status\nMSKU1234565,22G1,F\n';
  const seen = []; // {method, url, auth}

  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });

    if (req.method === 'POST' && req.url === '/api/auth/login') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const creds = JSON.parse(raw);
        if (creds.username === 'demo' && creds.password === 'demo-pass') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'tok-selftest-8h' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'bad credentials' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/jnpa/files?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            { sha256: 'aaa', filename: 'IAL APMT.csv', group: 'shipping-lines', message_type: 'IAL' },
            { sha256: 'bbb', filename: 'EAL_NSFT.csv', group: 'shipping-lines', message_type: 'EAL' },
            { sha256: 'ccc', filename: 'notes.pdf', group: 'shipping-lines', message_type: 'DOC' },
            { sha256: 'ddd', filename: 'eir_0001.json', group: 'eir', message_type: 'EIR' },
            { sha256: 'eee', filename: 'stray.csv', group: 'other-group', message_type: 'CSV' },
          ],
          count: 5,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/api/jnpa/files/aaa') {
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="IAL APMT.csv"',
      });
      res.end(CSV_TEXT);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/jnpa/files/bbb') {
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': "attachment; filename*=UTF-8''EAL_NSFT%20v2.csv",
      });
      res.end(CSV_TEXT);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/jnpa/files/nohdr') {
      res.writeHead(200, { 'Content-Type': 'text/csv' }); // no Content-Disposition
      res.end(CSV_TEXT);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.UC3_GATEWAY_URL = `http://127.0.0.1:${port}`;

  let failures = 0;
  const check = (name, cond, detail = '') => {
    if (cond) console.log(`  ok   ${name}`);
    else {
      failures++;
      console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  try {
    // 1. Login-optional flow (dev no-auth): creds unset.
    delete process.env.UC3_USERNAME;
    delete process.env.UC3_PASSWORD;
    const noToken = await login();
    check('login() returns null without credentials', noToken === null);
    check('no login request was made', !seen.some((r) => r.url === '/api/auth/login'));

    const anonList = await listShiplineFiles(noToken);
    const anonListReq = seen.find((r) => r.url?.startsWith('/api/jnpa/files?'));
    check('anonymous listing sends no Authorization header', anonListReq && anonListReq.auth === null);

    // 3. List filtering (applies to both auth modes).
    check(
      'listing filtered to shipping-lines CSVs only',
      anonList.length === 2 && anonList.map((i) => i.sha256).join(',') === 'aaa,bbb',
      `got ${JSON.stringify(anonList.map((i) => i.filename))}`,
    );
    check(
      'listing URL scoped with group=shipping-lines&limit=500',
      anonListReq && anonListReq.url.includes('group=shipping-lines') && anonListReq.url.includes('limit=500'),
    );

    // 2. Login flow: creds set.
    process.env.UC3_USERNAME = 'demo';
    process.env.UC3_PASSWORD = 'demo-pass';
    const token = await login();
    check('login() returns the gateway token', token === 'tok-selftest-8h');
    check('login request was posted', seen.some((r) => r.method === 'POST' && r.url === '/api/auth/login'));

    seen.length = 0;
    await listShiplineFiles(token);
    check(
      'authenticated listing carries Bearer token',
      seen[0] && seen[0].auth === 'Bearer tok-selftest-8h',
      `got auth=${seen[0]?.auth}`,
    );

    // 4. Filename extraction + body round-trip.
    const a = await fetchFileText('aaa', token);
    check('filename from quoted Content-Disposition', a.filename === 'IAL APMT.csv', `got ${a.filename}`);
    check('CSV text round-trips', a.text === CSV_TEXT);
    const b = await fetchFileText('bbb', token);
    check("filename from RFC 5987 filename* form", b.filename === 'EAL_NSFT v2.csv', `got ${b.filename}`);
    const c = await fetchFileText('nohdr', token);
    check('sha256 fallback when header absent', c.filename === 'nohdr', `got ${c.filename}`);
    const fetchReq = seen.find((r) => r.url === '/api/jnpa/files/aaa');
    check('file fetch carries Bearer token', fetchReq && fetchReq.auth === 'Bearer tok-selftest-8h');

    // Bad credentials must throw, not degrade to anonymous.
    process.env.UC3_PASSWORD = 'wrong';
    let threw = false;
    try {
      await login();
    } catch {
      threw = true;
    }
    check('login() throws on bad credentials', threw);
  } finally {
    server.close();
  }

  if (failures > 0) {
    console.error(`[gateway-source selftest] ${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('[gateway-source selftest] all checks passed');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--selftest')) {
  await selftest();
}
