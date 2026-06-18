/**
 * Gateway HTTP server (prompt §1). Adapts Node http to the pure Gateway.handle()
 * and adds a DEV-ONLY token endpoint so the PoC can mint a JWT without an OIDC
 * provider (production replaces /auth/dev-token with the OIDC redirect flow).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Role } from '@jnpa/schemas';
import { ROLES } from '@jnpa/schemas';
import type { BaselinesConfig } from '@jnpa/kpi';
import { Gateway } from './app.js';
import { issueToken } from './auth/jwt.js';
import { applySecurityHeaders } from './middleware.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const terminalsConfig = JSON.parse(readFileSync(join(root, 'config', 'terminals.json'), 'utf8'));
const baselines = JSON.parse(readFileSync(join(root, 'config', 'baselines.json'), 'utf8')) as BaselinesConfig;

const JWT_SECRET = process.env.JWT_DEV_SECRET ?? 'dev-only-insecure-change-me';
const AUDIENCE = process.env.OIDC_AUDIENCE ?? 'jnpa-uc2';
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);

const gateway = new Gateway({ terminalsConfig, baselines, jwtSecret: JWT_SECRET, audience: AUDIENCE });

const server = createServer((req, res) => {
  applySecurityHeaders(res);
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-consumer');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // DEV token endpoint (PoC only).
  if (req.method === 'POST' && url.pathname === '/auth/dev-token') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let role: Role = 'DTCCC_ADMIN';
      try {
        const parsed = JSON.parse(body || '{}') as { role?: Role; sub?: string };
        if (parsed.role && ROLES.includes(parsed.role)) role = parsed.role;
        const token = issueToken(
          { sub: parsed.sub ?? `dev-${role}`, role },
          { secret: JWT_SECRET, issuer: 'jnpa-uc2-dev', audience: AUDIENCE, nowSec: Math.floor(Date.now() / 1000) },
        );
        res.end(JSON.stringify({ token, role }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid body' }));
      }
    });
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed: unknown = undefined;
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    gateway
      .handle(req.method ?? 'GET', url.pathname, headers, parsed)
      .then((resp) => {
        res.statusCode = resp.status;
        res.end(JSON.stringify(resp.body));
      })
      .catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'error' }));
      });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[gateway] listening on :${PORT} (mode=${gateway.adapter.mode})`);
});
