import { describe, expect, it, vi } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { MockAdapter } from '../src/mock-adapter.js';
import { Poc3CargoAdapter, CargoApiError } from '../src/poc3-cargo-adapter.js';
import { mapCargoToMovement, mapCargoToScanEvent } from '../src/cargo-mapper.js';
import type { CargoRecord } from '../src/interface.js';

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

const RECORD: CargoRecord = {
  container_number: 'MAEU6123458',
  vessel_name: 'MAERSK SEMBAWANG',
  customs_status: 'CLEARED',
  yard_block: 'A-01',
  is_released: true,
  vehicle_number: 'MH04AB1234',
  gate: 'GATE-1',
  camera_id: 'CAM-ANPR-01',
  eta: '2026-07-12T06:30:00Z',
  created_at: '2026-07-10T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}
function created(body: unknown) {
  return { ok: true, status: 201, statusText: 'Created', json: async () => body } as unknown as Response;
}
function errorRes(status: number, detail?: unknown) {
  return { ok: false, status, statusText: `HTTP ${status}`, json: async () => (detail === undefined ? {} : { detail }) } as unknown as Response;
}
function notFound() {
  return errorRes(404);
}

function base() {
  return new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });
}

describe('mapCargoToMovement — faithful POC-3 → canonical DTO projection', () => {
  it('carries the raw record and derives line/status/trail from real fields', () => {
    const dto = mapCargoToMovement(RECORD);
    expect(dto.cargo).toBe(RECORD);
    expect(dto.container.containerNo).toBe('MAEU6123458');
    expect(dto.container.lineOwner).toBe('MAEU'); // ISO-6346 owner+category prefix
    expect(dto.container.status).toBe('GATE_OUT'); // released
    expect(dto.facilityId).toBe('A-01'); // yard block
    // Released record ends on a GATE_OUT milestone; trail is non-empty + ordered.
    expect(dto.trail.length).toBeGreaterThan(0);
    expect(dto.lastEventType).toBe('GATE_OUT');
    // No future/fabricated ETA event lives in the trail.
    expect(dto.trail.some((e) => e.eventType.includes('ETA'))).toBe(false);
  });

  it('derives HELD_CUSTOMS status for a held, un-released container', () => {
    const dto = mapCargoToMovement({ ...RECORD, is_released: false, customs_status: 'HELD' });
    expect(dto.container.status).toBe('HELD_CUSTOMS');
  });
});

describe('Poc3CargoAdapter — re-sources cargo from GET /api/cargo', () => {
  it('lists cargo and maps every row', async () => {
    const fetchImpl = vi.fn(async () => ok([RECORD]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const moves = await a.getContainerMovements({});
    expect(moves).toHaveLength(1);
    expect(moves[0]!.cargo?.container_number).toBe('MAEU6123458');
    // Hit the list endpoint with pagination defaults.
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/cargo');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('limit=100');
  });

  it('search routes an exact container number to the single-record endpoint', async () => {
    const fetchImpl = vi.fn(async () => ok(RECORD));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const moves = await a.getContainerMovements({ containerNo: 'maeu 6123458' });
    expect(moves).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/cargo/MAEU6123458');
  });

  it('treats a 404 on search as an empty result, not an error', async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.getContainerMovements({ containerNo: 'MAEU6123458' })).resolves.toEqual([]);
  });

  it('short-circuits an invalid ISO-6346 search without a network call', async () => {
    const fetchImpl = vi.fn(async () => ok(RECORD));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.getContainerMovements({ containerNo: 'NOTVALID' })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delegates a non-cargo method to the base adapter', async () => {
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: (async () => ok([])) as unknown as typeof fetch });
    expect((await a.getTerminals()).length).toBeGreaterThan(0);
    expect(a.mode).toBe('mock');
  });
});

describe('Poc3CargoAdapter.updateCargo — PUT to the existing cargo resource (never PATCH)', () => {
  it('PUTs /api/cargo/{id} with only the changed field and maps the response', async () => {
    const discharged: CargoRecord = { ...RECORD, yard_block: 'B-07' };
    const fetchImpl = vi.fn(async () => ok(discharged));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const dto = await a.updateCargo('maeu 6123458', { yard_block: 'B-07' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/MAEU6123458');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ yard_block: 'B-07' });
    expect(dto.cargo?.yard_block).toBe('B-07'); // mapped via the shared cargo mapper
  });

  it('never issues a PATCH request for any update', async () => {
    const fetchImpl = vi.fn(async () => ok({ ...RECORD, is_released: true }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await a.updateCargo('MAEU6123458', { is_released: true });
    const methods = fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).not.toContain('PATCH');
    expect(methods).toEqual(['PUT']);
  });

  it('maps a 404 to a typed CargoApiError', async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.updateCargo('MAEU6123458', { is_released: true })).rejects.toMatchObject({ status: 404 });
  });
});

describe('Poc3CargoAdapter.createCargo — POST /api/cargo (201)', () => {
  it('POSTs the normalised record and maps the created row', async () => {
    const fetchImpl = vi.fn(async () => created(RECORD));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const dto = await a.createCargo({ container_number: 'maeu 6123458', vessel_name: 'MAERSK SEMBAWANG' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).container_number).toBe('MAEU6123458'); // normalised
    expect(dto.container.containerNo).toBe('MAEU6123458');
  });

  it('surfaces a duplicate as a 409 CargoApiError with a user message', async () => {
    const fetchImpl = vi.fn(async () => errorRes(409, { error: 'duplicate_container' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await a.createCargo({ container_number: 'MAEU6123458' }).catch((e) => e);
    expect(err).toBeInstanceOf(CargoApiError);
    expect(err.status).toBe(409);
    expect(err.userMessage).toMatch(/already exists/i);
  });
});

describe('Poc3CargoAdapter.deleteCargo — DELETE /api/cargo/{id} (200)', () => {
  it('DELETEs the normalised resource and resolves on success', async () => {
    const fetchImpl = vi.fn(async () => ok({ deleted: true, container_number: 'MAEU6123458' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.deleteCargo('maeu 6123458')).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/MAEU6123458');
    expect(init.method).toBe('DELETE');
  });

  it('maps a missing container to a 404 CargoApiError', async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.deleteCargo('MAEU6123458')).rejects.toMatchObject({ status: 404 });
  });
});

describe('Scan queue re-sourced from POC-3 cargo (no simulated release targets)', () => {
  it('maps a cargo record to a ScanEvent with a customs-derived result', () => {
    const held = mapCargoToScanEvent({ ...RECORD, is_released: false, customs_status: 'HELD' });
    expect(held.containerNo).toBe('MAEU6123458');
    expect(held.result).toBe('HOLD');
    expect(mapCargoToScanEvent({ ...RECORD, customs_status: 'UNDER_INSPECTION' }).result).toBe('EXAM');
    expect(mapCargoToScanEvent({ ...RECORD, customs_status: 'PENDING' }).result).toBeUndefined();
  });

  it('getScanQueue fetches only not-yet-released cargo and maps every row', async () => {
    const inPort: CargoRecord = { ...RECORD, is_released: false, customs_status: 'PENDING' };
    const fetchImpl = vi.fn(async () => ok([inPort]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const scans = await a.getScanQueue();
    expect(scans).toHaveLength(1);
    expect(scans[0]!.containerNo).toBe('MAEU6123458'); // a real POC-3 container, not a sim one
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/api/cargo');
    expect(url).toContain('is_released=false');
  });
});

describe('Poc3CargoAdapter — extended Cargo APIs (Jayesh handover)', () => {
  it('createCargoNotification POSTs to /api/cargo/notifications', async () => {
    const fetchImpl = vi.fn(async () => created({ id: 1, message: 'hi', severity: 'WARN' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const n = await a.createCargoNotification({ message: 'hi', severity: 'WARN', stakeholders: ['CUSTOMS'] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/notifications');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ message: 'hi', stakeholders: ['CUSTOMS'] });
    expect(n.severity).toBe('WARN');
  });

  it('getCargoNotifications lists + tolerates an { items } envelope + passes filters', async () => {
    const fetchImpl = vi.fn(async () => ok({ items: [{ id: 1, message: 'a' }, { id: 2, message: 'b' }] }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await a.getCargoNotifications({ severity: 'CRIT', limit: 10 });
    expect(rows).toHaveLength(2);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('/api/cargo/notifications');
    expect(url).toContain('severity=CRIT');
    expect(url).toContain('limit=10');
  });

  it('triggerCargoWorkflow POSTs the normalised container path with the action', async () => {
    const fetchImpl = vi.fn(async () => ok({ container_number: 'MAEU6123458', status: 'APPROVED' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const st = await a.triggerCargoWorkflow('maeu 6123458', { action: 'APPROVE', note: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/MAEU6123458/workflow');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'APPROVE', note: 'ok' });
    expect(st.status).toBe('APPROVED');
  });

  it('getCargoWorkflowHistory GETs the append-only history endpoint', async () => {
    const fetchImpl = vi.fn(async () => ok([{ id: 1, action: 'TRIGGER', status: 'PENDING' }]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const hist = await a.getCargoWorkflowHistory('MAEU6123458');
    expect(hist).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/cargo/MAEU6123458/workflow/history');
  });

  it('createYardPlan POSTs a normalised container to /api/cargo/yard-planning', async () => {
    const fetchImpl = vi.fn(async () => created({ container_number: 'MAEU6123458', yard_block: 'A-12' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await a.createYardPlan({ container_number: 'maeu 6123458', preferred_block: 'A-12' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/yard-planning');
    expect(init.method).toBe('POST');
    // Deployed backend requires `preferred_block` as a ZONE LETTER only, so the
    // full block "A-12" is reduced to "A" in the request payload.
    expect(JSON.parse(String(init.body))).toMatchObject({ container_number: 'MAEU6123458', preferred_block: 'A' });
    expect(r.yard_block).toBe('A-12');
  });

  it('getYardOptimization GETs the optimization snapshot', async () => {
    const body = { congestion: [{ yard_block: 'A', utilization: 0.9 }], priority_containers: [], suggested_moves: [] };
    const fetchImpl = vi.fn(async () => ok(body));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const o = await a.getYardOptimization();
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/cargo/yard-optimization');
    expect(o.congestion?.[0]?.yard_block).toBe('A');
  });

  it('createRakePlan / getRakePlans hit /api/cargo/rake-planning', async () => {
    const post = vi.fn(async () => created({ id: 1, rake_id: 'RAKE-1' }));
    const a1 = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: post as unknown as typeof fetch });
    const p = await a1.createRakePlan({ rake_id: 'RAKE-1', siding: 'T1' });
    expect((post.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(String(post.mock.calls[0]![0])).toContain('/api/cargo/rake-planning');
    expect(p.rake_id).toBe('RAKE-1');

    const get = vi.fn(async () => ok([{ id: 1, rake_id: 'RAKE-1' }]));
    const a2 = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: get as unknown as typeof fetch });
    expect(await a2.getRakePlans()).toHaveLength(1);
    expect(String(get.mock.calls[0]![0])).toContain('/api/cargo/rake-planning');
  });

  it('createReeferPlan POSTs a normalised container with temp/power', async () => {
    const fetchImpl = vi.fn(async () => created({ id: 1, container_number: 'MNBU3011234', slot: 'RP-04' }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await a.createReeferPlan({ container_number: 'mnbu 3011234', temperature_c: -18, power_kw: 7.5 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/cargo/reefer-planning');
    expect(JSON.parse(String(init.body))).toMatchObject({ container_number: 'MNBU3011234', temperature_c: -18, power_kw: 7.5 });
    expect(r.slot).toBe('RP-04');
  });

  it('getCargoEvents lists events and scopes to a container when given', async () => {
    const fetchImpl = vi.fn(async () => ok([{ id: 1, event_type: 'cargo.gate_in', container_number: 'MAEU6123458' }]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const all = await a.getCargoEvents();
    expect(all).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/cargo/events');
    await a.getCargoEvents('maeu 6123458');
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('container_number=MAEU6123458');
  });

  it('carries the bearer token on an extended-API call too', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const a = new Poc3CargoAdapter(base(), {
      cargoBaseUrl: '/poc3', getToken: () => 'TESTTOKEN', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await a.getCargoNotifications();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TESTTOKEN');
  });

  it('maps a non-2xx extended-API response to a typed CargoApiError', async () => {
    const fetchImpl = vi.fn(async () => errorRes(500, 'boom'));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.getYardOptimization()).rejects.toBeInstanceOf(CargoApiError);
  });
});

describe('Poc3CargoAdapter — auth: bearer on every request + 401 self-heal', () => {
  it('attaches Authorization: Bearer <token> to every cargo request', async () => {
    const fetchImpl = vi.fn(async () => ok([RECORD]));
    const a = new Poc3CargoAdapter(base(), {
      cargoBaseUrl: '/poc3', getToken: () => 'TESTTOKEN', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await a.getContainerMovements({});
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TESTTOKEN');
  });

  it('re-mints the token once on a 401 and retries with the fresh bearer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorRes(401, 'missing bearer token'))
      .mockResolvedValueOnce(ok([RECORD]));
    let current: string | undefined = undefined;
    const refreshToken = vi.fn(async () => 'FRESH');
    const a = new Poc3CargoAdapter(base(), {
      cargoBaseUrl: '/poc3',
      getToken: () => current,
      setToken: (t) => { current = t; },
      refreshToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const moves = await a.getContainerMovements({});
    expect(moves).toHaveLength(1);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers as Record<string, string>).toMatchObject({ authorization: 'Bearer FRESH' });
    expect(current).toBe('FRESH'); // stored for subsequent calls
  });
});
