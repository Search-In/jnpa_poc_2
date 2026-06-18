import { describe, expect, it } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import { Gateway } from '../src/app.js';
import { issueToken } from '../src/auth/jwt.js';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof Gateway>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;
const SECRET = 'test-secret';
const AUD = 'jnpa-uc2';
const NOW = 1_780_000_000;

function gw() {
  return new Gateway({
    terminalsConfig: terminals, baselines, jwtSecret: SECRET, audience: AUD,
    nowSec: () => NOW, nowIso: () => '2026-06-17T00:00:00.000Z',
  });
}

function token(role: string, sub = 'u1') {
  return issueToken({ sub, role: role as never }, { secret: SECRET, issuer: 'test', audience: AUD, nowSec: NOW });
}

const bearer = (role: string) => ({ authorization: `Bearer ${token(role)}`, 'x-consumer': `c-${role}` });

describe('Gateway auth + RBAC', () => {
  it('health is public', async () => {
    const r = await gw().handle('GET', '/health', {}, undefined);
    expect(r.status).toBe(200);
  });

  it('rejects missing/invalid token on /api/*', async () => {
    const r = await gw().handle('GET', '/api/kpis', { 'x-consumer': 'x' }, undefined);
    expect(r.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = issueToken({ sub: 'u', role: 'DTCCC_ADMIN' as never }, { secret: SECRET, issuer: 't', audience: AUD, nowSec: NOW - 10_000, ttlSec: 1 });
    const r = await gw().handle('GET', '/api/kpis', { authorization: `Bearer ${expired}`, 'x-consumer': 'x' }, undefined);
    expect(r.status).toBe(401);
  });

  it('serves KPIs to an authenticated role', async () => {
    const r = await gw().handle('GET', '/api/kpis', bearer('DTCCC_ADMIN'), undefined);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBe(10);
  });

  it('scopes facilities by role (CFS_OPERATOR sees only CFS)', async () => {
    const r = await gw().handle('GET', '/api/facilities', bearer('CFS_OPERATOR'), undefined);
    const facilities = r.body as Array<{ type: string }>;
    expect(facilities.every((f) => f.type === 'CFS')).toBe(true);
  });

  it('forbids scenario run for a facility-scoped role', async () => {
    const r = await gw().handle('POST', '/api/scenarios/CGO-1', bearer('CFS_OPERATOR'), {});
    expect(r.status).toBe(403);
  });

  it('allows scenario run for DTCCC_ADMIN and returns cross-twin event for CGO-2', async () => {
    const r = await gw().handle('POST', '/api/scenarios/CGO-2', bearer('DTCCC_ADMIN'), { gateId: 'NSICT-G1' });
    expect(r.status).toBe(200);
    expect((r.body as { crossTwinEvent?: { target: string } }).crossTwinEvent?.target).toBe('UC3');
  });

  it('audit endpoint is admin-only', async () => {
    expect((await gw().handle('GET', '/api/audit', bearer('CUSTOMS'), undefined)).status).toBe(403);
    expect((await gw().handle('GET', '/api/audit', bearer('DTCCC_ADMIN'), undefined)).status).toBe(200);
  });
});

describe('Gateway rate limiting', () => {
  it('429s after the per-consumer burst is exhausted', async () => {
    const g = gw();
    const h = bearer('DTCCC_ADMIN');
    let limited = false;
    for (let i = 0; i < 200; i++) {
      const r = await g.handle('GET', '/api/kpis', h, undefined);
      if (r.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

describe('Gateway gate-automation feed (§13)', () => {
  it('returns a structured ALLOW/HOLD/DENY decision', async () => {
    const r = await gw().handle(
      'POST', '/api/gate-decision', bearer('TERMINAL_OPS'),
      { gateId: 'NSICT-G1', vehicleNo: 'MH04AB1234', containerNo: 'MAEU1234567', customsStatus: 'CLEAR' },
    );
    expect(r.status).toBe(200);
    const d = r.body as { decision: string; checks: Record<string, boolean> };
    expect(['ALLOW', 'HOLD', 'DENY']).toContain(d.decision);
    expect(d.checks).toHaveProperty('esealIntact');
  });

  it('DENYs on an unknown vehicle non-compliance', async () => {
    const r = await gw().handle(
      'POST', '/api/gate-decision', bearer('TERMINAL_OPS'),
      { gateId: 'NSICT-G1', vehicleNo: 'MH04ZZ0000', containerNo: 'NEWU0000000', vehicleCompliant: false },
    );
    expect((r.body as { decision: string }).decision).toBe('DENY');
  });
});
