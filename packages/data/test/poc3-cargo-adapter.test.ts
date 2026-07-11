import { describe, expect, it, vi } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { MockAdapter } from '../src/mock-adapter.js';
import { Poc3CargoAdapter } from '../src/poc3-cargo-adapter.js';
import { mapCargoToMovement } from '../src/cargo-mapper.js';
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
function notFound() {
  return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as unknown as Response;
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
