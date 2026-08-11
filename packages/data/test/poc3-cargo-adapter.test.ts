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

  it('search sends container_number so it filters SERVER-SIDE, normalised', async () => {
    // Regression guard. Search used to take a separate route (an exact lookup on
    // /api/cargo/{id}); when the paged read replaced that branch, the parameter went
    // with it and Search silently returned page 1 of everything — which reads on
    // screen as "no result". The query MUST carry the container number.
    const fetchImpl = vi.fn(async () => ok([RECORD]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const moves = await a.getContainerMovements({ containerNo: 'maeu 6123458' });
    expect(moves).toHaveLength(1);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain('container_number=MAEU6123458'); // upper-cased, spaces stripped
  });

  it('a search that matches nothing is an empty result, not an error', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.getContainerMovements({ containerNo: 'MAEU6123458' })).resolves.toEqual([]);
  });

  it('does NOT pre-screen the search on the ISO-6346 check digit', async () => {
    // The New Cargo dialog deliberately accepts numbers whose check digit fails, so
    // screening here would make a container you just created unfindable — and the
    // failure was silent, because it returned [] with no request and no message.
    const fetchImpl = vi.fn(async () => ok([]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await a.getContainerMovements({ containerNo: 'NOTVALID' });
    expect(fetchImpl).toHaveBeenCalled(); // the server decides, not the client
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

describe('409 conflict messages — one status, several situations', () => {
  const releaseConflict = async (detail?: unknown) => {
    const fetchImpl = vi.fn(async () => errorRes(409, detail));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    return a.releaseCargo('MAEU6123458').catch((e) => e as CargoApiError);
  };

  it('reports a customs-blocked release as customs, not as a duplicate record', async () => {
    // The MAEU6123458 case: VERIFIED + UNDER_INSPECTION, so `release_cargo` hits
    // CUSTOMS_BLOCKS_RELEASE. Reporting that as "a cargo record with this
    // container number already exists" sent operators hunting a duplicate that
    // does not exist, for a release that was correctly refused.
    const err = await releaseConflict({
      error: 'customs_not_cleared', container_number: 'MAEU6123458',
      customs_status: 'UNDER_INSPECTION', attempted_status: 'RELEASED',
      message: 'Customs has not released these goods (customs_status=UNDER_INSPECTION).',
    });
    expect(err.status).toBe(409);
    // The backend writes an operator-ready sentence; use it verbatim.
    expect(err.userMessage).toBe('Customs has not released these goods (customs_status=UNDER_INSPECTION).');
    expect(err.userMessage).not.toMatch(/already exists/i);
  });

  it('falls back to its own customs wording when the backend sends no message', async () => {
    const err = await releaseConflict({
      error: 'customs_not_cleared', container_number: 'MAEU6123458', customs_status: 'HELD',
    });
    expect(err.userMessage).toMatch(/customs has not released these goods/i);
    expect(err.userMessage).toMatch(/HELD/);
  });

  it('names both ends of an illegal transition', async () => {
    const err = await releaseConflict({
      error: 'illegal_transition', container_number: 'MAEU6123458',
      current_status: 'YARD_ASSIGNED', attempted_status: 'RELEASED',
    });
    expect(err.userMessage).toMatch(/YARD_ASSIGNED/);
    expect(err.userMessage).toMatch(/RELEASED/);
    expect(err.userMessage).not.toMatch(/already exists/i);
  });

  it('surfaces the 400 validation reason, which nests under `detail` not `message`', async () => {
    const fetchImpl = vi.fn(async () => errorRes(400, {
      error: 'validation_error', container_number: 'MAEU612345',
      detail: 'MAEU612345 is not a valid ISO-6346 container number',
    }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await a.releaseCargo('MAEU612345').catch((e) => e as CargoApiError);
    expect(err.userMessage).toBe('MAEU612345 is not a valid ISO-6346 container number');
    expect(err.userMessage).not.toMatch(/[{}]/);
  });

  it('never shows the raw JSON detail blob', async () => {
    const err = await releaseConflict({ error: 'something_new', container_number: 'MAEU6123458' });
    expect(err.userMessage).not.toMatch(/[{}]/);
    expect(err.userMessage).toMatch(/conflicts with/i);
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
    // The RAW disposition rides along too. `result` is lossy — the Scan tab used
    // to reconstruct customs_status from it and lost EXAM on the way, so the
    // release dialog never learned the box was under examination.
    const exam = mapCargoToScanEvent({ ...RECORD, customs_status: 'UNDER_INSPECTION' });
    expect((exam as { customsStatus?: string }).customsStatus).toBe('UNDER_INSPECTION');
    expect((held as { customsStatus?: string }).customsStatus).toBe('HELD');
  });

  it('getScanQueue reads the /scan-queue endpoint and enriches each member', async () => {
    // The queue's membership rule is the SERVER's ("not released AND yard-assigned
    // AND not yet verified"), so it must come from /api/cargo/scan-queue. It used
    // to read /api/cargo?is_released=false and let the panel filter on yard_block
    // client-side, which only matched the real queue by coincidence.
    const inPort: CargoRecord = { ...RECORD, is_released: false, customs_status: 'PENDING' };
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('/scan-queue')
        ? ok([{ container_number: 'MAEU6123458', yard_block: 'A-12', status: 'SCAN_PENDING' }])
        : ok(inPort)); // the per-container enrich returns ONE record, not a list
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const scans = await a.getScanQueue();
    expect(scans).toHaveLength(1);
    expect(scans[0]!.containerNo).toBe('MAEU6123458'); // a real POC-3 container, not a sim one

    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('/api/cargo/scan-queue');
    // Enriched from the full record, so the panel's columns keep their values.
    expect(urls.some((u) => u.includes('/api/cargo/MAEU6123458'))).toBe(true);
  });

  it('release / verify / yard-assignment use their own endpoints, not a column patch', async () => {
    // Each is a distinct audited transition that emits its own event. PUT
    // {is_released:true} faces the same VERIFY gate but reads as a field patch,
    // which is what made a blocked release look like a failure.
    const fetchImpl = vi.fn(async () => ok(RECORD));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    await a.assignYard('MAEU6123458', 'A-12');
    await a.verifyCargo('MAEU6123458', { verified: true });
    await a.releaseCargo('MAEU6123458');

    const calls = fetchImpl.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method]);
    expect(calls[0]).toEqual([expect.stringContaining('/api/cargo/MAEU6123458/yard-assignment'), 'PUT']);
    expect(calls[1]).toEqual([expect.stringContaining('/api/cargo/MAEU6123458/verify'), 'POST']);
    expect(calls[2]).toEqual([expect.stringContaining('/api/cargo/MAEU6123458/release'), 'POST']);
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

describe('Poc3CargoAdapter — IGM (customs manifest layer)', () => {
  /** The customs endpoints return the `{items, total, …}` page envelope. */
  const page = (items: unknown[], total = items.length) =>
    ok({ items, total, limit: items.length, offset: 0, count: items.length });

  const MANIFEST = {
    igm_no: 1194313, igm_date: '2026-05-19', imo_code: '9523017', vessel_code: 'BPKG',
    voyage_no: '213', shipping_line_code: 'CHZ', terminal_operator_code: 'INNSA1NSI1',
    line_count: 311, container_count: 752,
  };
  const CONTAINER = {
    igm_no: 1194313, line_no: 241, subline_no: 0, container_no: 'DPWU9011100',
    seal_no: 'UFL498836', container_agent_code: 'AAECP2527J', container_status: 'FCL',
    no_of_packages: 16, container_weight: '1.350', iso_size_type: '4210',
  };

  it('lists manifests from /api/customs/igm and unwraps the page envelope', async () => {
    const fetchImpl = vi.fn(async () => page([MANIFEST]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await a.getIgmManifests();
    expect(rows).toEqual([MANIFEST]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/customs/igm');
  });

  it('lists the containers declared on one manifest', async () => {
    const fetchImpl = vi.fn(async () => page([CONTAINER]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await a.getIgmContainers(1194313);
    expect(rows).toEqual([CONTAINER]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/customs/igm/1194313/containers');
  });

  it('pages through a manifest larger than one 2000-row page instead of truncating', async () => {
    // 2 794 containers = a full page + a partial one, mirroring the real corpus.
    const full = Array.from({ length: 2000 }, (_, i) => ({ ...CONTAINER, container_no: `AAAU000000${i}` }));
    const tail = Array.from({ length: 794 }, (_, i) => ({ ...CONTAINER, container_no: `BBBU000000${i}` }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(full, 2794))
      .mockResolvedValueOnce(page(tail, 2794));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = await a.getIgmContainers(1193612);
    expect(rows).toHaveLength(2794);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('offset=2000');
  });

  it('honours an explicit limit as a single page (no paging)', async () => {
    const fetchImpl = vi.fn(async () => page([CONTAINER]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await a.getIgmContainers(1194313, { limit: 50 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('limit=50');
  });

  it('carries the bearer token and surfaces a 403 as a typed CargoApiError', async () => {
    const fetchImpl = vi.fn(async () => errorRes(403, 'forbidden'));
    const a = new Poc3CargoAdapter(base(), {
      cargoBaseUrl: '/poc3', getToken: () => 'TESTTOKEN', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(a.getIgmManifests()).rejects.toBeInstanceOf(CargoApiError);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TESTTOKEN');
  });
});

describe('Poc3CargoAdapter — in-flight GET de-duplication', () => {
  /** Resolve manually so both calls are provably in flight at the same time. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('collapses two identical concurrent GETs into ONE network request', async () => {
    // This is what stops React StrictMode's double-invoked effects from firing
    // every panel's fetch twice in development.
    const gate = deferred<void>();
    const fetchImpl = vi.fn(async () => { await gate.promise; return ok([RECORD]); });
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = a.getContainerMovements({});
    const second = a.getContainerMovements({});
    gate.resolve();
    const [r1, r2] = await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('does NOT collapse GETs with different query params', async () => {
    const fetchImpl = vi.fn(async () => ok([RECORD]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([
      a.getContainerMovements({}),
      a.getContainerMovements({ isReleased: false }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is not a response cache — a later identical GET refetches', async () => {
    // Critical: a refetch after a write must see fresh data, so the dedup entry
    // has to be dropped once the request settles.
    const fetchImpl = vi.fn(async () => ok([RECORD]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await a.getContainerMovements({});
    await a.getContainerMovements({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares the rejection with both callers, then clears the entry', async () => {
    const fetchImpl = vi.fn(async () => errorRes(500, 'boom'));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    const both = await Promise.allSettled([a.getContainerMovements({}), a.getContainerMovements({})]);
    expect(both.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Entry cleared → a retry actually hits the network again.
    await expect(a.getContainerMovements({})).rejects.toBeInstanceOf(CargoApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never collapses writes — two POSTs are two intents', async () => {
    const fetchImpl = vi.fn(async () => created(RECORD));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([
      a.createCargo({ container_number: 'MAEU6123458' }),
      a.createCargo({ container_number: 'MAEU6123458' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Poc3CargoAdapter — RMS container scanning', () => {
  const page = (items: unknown[], total = items.length) =>
    ok({ items, total, limit: items.length, offset: 0, count: items.length });

  const LIST = {
    report_id: 4, igm_no: 1194257, igm_year: 2026, vessel_name: 'BSG BIMINI',
    shipping_line: 'MAERSK INDIA PVT LTD', shipping_agent: 'AAHCM0698N',
    processing_end_date: '2026-06-11', selected_count: 20, any_selected: true,
  };
  const SELECTION = {
    igm_no: 1194257, sl_no: 16, container_no: 'MRKU9527629',
    machine_type: 'M', scan_location: 'INNSA1SDMB02', cfs_name: 'CONCOR ICD MIHAN',
  };

  it('lists the issued scan lists from /api/customs/rms', async () => {
    const fetchImpl = vi.fn(async () => page([LIST]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await a.getRmsScanLists()).toEqual([LIST]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/customs/rms');
  });

  it('lists the containers one scan list selected', async () => {
    const fetchImpl = vi.fn(async () => page([SELECTION]));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await a.getRmsScanContainers(1194257)).toEqual([SELECTION]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/customs/rms/1194257/containers');
  });

  it('returns an empty list — not an error — for "No container selected for scanning"', async () => {
    // A scan list that selected nothing is a real, meaningful outcome; the adapter
    // must surface it as [] so the panel can state it rather than show an error.
    const fetchImpl = vi.fn(async () => page([], 0));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(a.getRmsScanContainers(1193499)).resolves.toEqual([]);
  });

  it('carries the bearer token on the scanning endpoints', async () => {
    const fetchImpl = vi.fn(async () => page([]));
    const a = new Poc3CargoAdapter(base(), {
      cargoBaseUrl: '/poc3', getToken: () => 'TESTTOKEN', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await a.getRmsScanContainers(1194257);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer TESTTOKEN');
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

describe('Poc3CargoAdapter — JNPA Port-Data API feed state (UC2-006)', () => {
  const HEALTH = {
    configured: false,
    mode: 'DISABLED',
    api_url: 'https://dt.jnpa.in/poc-api-data-access',
    groups: [
      { group: 'customs', kind: 'indexed', watermark_ts: '2026-08-07T06:44:45Z', last_status: 'ERROR', updated_at: '2026-08-07T09:36:09Z' },
      { group: 'bathymetry', kind: 'static', watermark_ts: null, last_status: 'SKIPPED_STATIC', updated_at: '2026-08-07T09:36:09Z' },
    ],
    last_run: { id: 4541, group_slug: 'daily-reports', status: 'ERROR', error: 'Malformed reply' },
  };

  it('reads health and never lets an absent groups array reach the panel', async () => {
    const fetchImpl = vi.fn(async () => ok({ ...HEALTH, groups: undefined }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const health = await a.getJnpaApiHealth();

    expect(fetchImpl.mock.calls[0][0]).toContain('/poc3/api/integrations/jnpa/health');
    // A missing array must become [], not undefined: the panel maps over it and a
    // crashed Integration tab is a worse failure than an empty one.
    expect(health.groups).toEqual([]);
    expect(health.configured).toBe(false);
  });

  it('surfaces the DISABLED mode verbatim rather than inferring health', async () => {
    const fetchImpl = vi.fn(async () => ok(HEALTH));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const health = await a.getJnpaApiHealth();

    expect(health.mode).toBe('DISABLED');
    expect(health.groups).toHaveLength(2);
    expect(health.last_run?.error).toBe('Malformed reply');
  });

  it('requests the run trail with an explicit limit and unwraps the items envelope', async () => {
    const fetchImpl = vi.fn(async () => ok({ items: [{ id: 4541, status: 'ERROR' }], count: 1 }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const runs = await a.getJnpaApiRuns(50);

    expect(String(fetchImpl.mock.calls[0][0])).toContain('limit=50');
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(4541);
  });

  it('asks the defect register for JSON, and reports an empty register as empty', async () => {
    // The endpoint also serves Markdown; asking for the wrong format would give
    // the panel a string it would silently render as zero defects.
    const fetchImpl = vi.fn(async () => ok({ items: [], count: 0 }));
    const a = new Poc3CargoAdapter(base(), { cargoBaseUrl: '/poc3', fetchImpl: fetchImpl as unknown as typeof fetch });

    const defects = await a.getJnpaApiDefects();

    expect(String(fetchImpl.mock.calls[0][0])).toContain('format=json');
    expect(defects).toEqual([]);
  });
});
