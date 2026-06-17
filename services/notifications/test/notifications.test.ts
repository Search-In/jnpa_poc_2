import { describe, expect, it } from 'vitest';
import type { CargoEvent } from '@jnpa/schemas';
import { InMemoryEventBus, TOPICS, cargoEventEnvelope } from '@jnpa/sim';
import { NotificationService, eventToNotification } from '../src/index.js';

function ev(eventType: CargoEvent['eventType'], over: Partial<CargoEvent> = {}): CargoEvent {
  return {
    eventId: `E-${eventType}-${Math.round(Math.random() * 1e6)}`,
    containerNo: 'MAEU1234567',
    eventType,
    ts: '2026-06-17T08:00:00.000Z',
    sourceOffsetMin: 330,
    facilityId: 'NSICT',
    gateId: 'NSICT-G1',
    sourceSystem: 'TOS',
    rawRef: 'raw/x',
    payload: {},
    ...over,
  };
}

describe('event → notification mapping (§11)', () => {
  it('maps CUSTOMS_FLAG to a WARN CUSTOMS_SCANNER_FLAG for customs roles, trilingual', () => {
    const n = eventToNotification(ev('CUSTOMS_FLAG'))!;
    expect(n.type).toBe('CUSTOMS_SCANNER_FLAG');
    expect(n.severity).toBe('WARN');
    expect(n.audienceRoles).toContain('CUSTOMS');
    expect(n.body.en.length).toBeGreaterThan(0);
    expect(n.body.hi.length).toBeGreaterThan(0);
    expect(n.body.mr.length).toBeGreaterThan(0);
  });

  it('maps DAMAGE_FLAG to CRIT DAMAGE_ASSESSMENT', () => {
    expect(eventToNotification(ev('DAMAGE_FLAG'))!.severity).toBe('CRIT');
  });

  it('maps ESEAL_BREAK to CRIT SPECIAL_INSTRUCTION', () => {
    const n = eventToNotification(ev('ESEAL_BREAK'))!;
    expect(n.type).toBe('SPECIAL_INSTRUCTION');
    expect(n.severity).toBe('CRIT');
  });

  it('returns null for events with no notification mapping', () => {
    expect(eventToNotification(ev('YARD_MOVE'))).toBeNull();
  });
});

describe('NotificationService fan-out + ack', () => {
  it('subscribes to the bus and fans out notifications', () => {
    const bus = new InMemoryEventBus();
    const svc = new NotificationService(bus);
    svc.start();
    bus.publish(TOPICS.cargoEvents, cargoEventEnvelope(ev('GATE_IN'), 'SYNTHETIC'));
    bus.publish(TOPICS.cargoEvents, cargoEventEnvelope(ev('YARD_MOVE'), 'SYNTHETIC')); // no notif
    expect(svc.all.length).toBe(1);
    expect(svc.all[0]!.type).toBe('GATE_IN');
  });

  it('filters by role and tracks acks', () => {
    const svc = new NotificationService();
    svc.ingestBatch([ev('CUSTOMS_FLAG'), ev('GATE_IN')]);
    const customs = svc.forRole('CUSTOMS');
    expect(customs.length).toBe(1);
    const ok = svc.ack(customs[0]!.notifId, 'officer1', '2026-06-17T09:00:00.000Z');
    expect(ok).toBe(true);
    expect(svc.forRole('CUSTOMS')[0]!.ackBy).toBe('officer1');
  });
});
