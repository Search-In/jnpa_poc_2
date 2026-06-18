/**
 * @jnpa/notifications (prompt §11) — event → notification fan-out + ack tracking.
 * Subscribes to the cargo-event topic, maps qualifying events to typed,
 * severity-tagged, multilingual, role-targeted Notifications, and tracks acks.
 * The mapping from event → notification is the §11 list (+ §7.4 anomalies).
 */
import type {
  CargoEvent,
  Notification,
  NotificationType,
  Role,
  Severity,
} from '@jnpa/schemas';
import type { CloudEvent, EventBus } from '@jnpa/sim';
import { TOPICS } from '@jnpa/sim';

let seq = 0;

interface Mapping {
  type: NotificationType;
  severity: Severity;
  audienceRoles: Role[];
  body: (e: CargoEvent) => { en: string; hi: string; mr: string };
}

/** event eventType → notification mapping (prompt §11). */
const EVENT_MAP: Partial<Record<CargoEvent['eventType'], Mapping>> = {
  GATE_IN: {
    type: 'GATE_IN', severity: 'INFO', audienceRoles: ['TERMINAL_OPS', 'DTCCC_ADMIN'],
    body: (e) => ({
      en: `Gate-in: ${e.containerNo} at ${e.gateId ?? e.facilityId}.`,
      hi: `गेट-इन: ${e.gateId ?? e.facilityId} पर ${e.containerNo}।`,
      mr: `गेट-इन: ${e.gateId ?? e.facilityId} येथे ${e.containerNo}.`,
    }),
  },
  GATE_OUT: {
    type: 'GATE_OUT', severity: 'INFO', audienceRoles: ['TERMINAL_OPS', 'DTCCC_ADMIN'],
    body: (e) => ({
      en: `Gate-out (CODECO): ${e.containerNo} cleared at ${e.gateId ?? e.facilityId}.`,
      hi: `गेट-आउट (CODECO): ${e.gateId ?? e.facilityId} पर ${e.containerNo} मुक्त।`,
      mr: `गेट-आउट (CODECO): ${e.gateId ?? e.facilityId} येथे ${e.containerNo} मुक्त.`,
    }),
  },
  CUSTOMS_FLAG: {
    type: 'CUSTOMS_SCANNER_FLAG', severity: 'WARN', audienceRoles: ['CUSTOMS', 'TERMINAL_OPS', 'DTCCC_ADMIN'],
    body: (e) => ({
      en: `Container ${e.containerNo} flagged for customs scan at ${e.facilityId}.`,
      hi: `कंटेनर ${e.containerNo} को ${e.facilityId} पर सीमा शुल्क स्कैन हेतु चिह्नित किया गया।`,
      mr: `कंटेनर ${e.containerNo} ${e.facilityId} येथे सीमाशुल्क स्कॅनसाठी चिन्हांकित.`,
    }),
  },
  DAMAGE_FLAG: {
    type: 'DAMAGE_ASSESSMENT', severity: 'CRIT', audienceRoles: ['TERMINAL_OPS', 'SHIPPING_LINE', 'DTCCC_ADMIN'],
    body: (e) => ({
      en: `Damage reported on ${e.containerNo} at ${e.facilityId}. Inspection required.`,
      hi: `${e.facilityId} पर ${e.containerNo} में क्षति की सूचना। निरीक्षण आवश्यक।`,
      mr: `${e.facilityId} येथे ${e.containerNo} वर नुकसान नोंदवले. तपासणी आवश्यक.`,
    }),
  },
  ESEAL_BREAK: {
    type: 'SPECIAL_INSTRUCTION', severity: 'CRIT', audienceRoles: ['CUSTOMS', 'TERMINAL_OPS', 'DTCCC_ADMIN'],
    body: (e) => ({
      en: `E-seal break on ${e.containerNo}. Hold for inspection.`,
      hi: `${e.containerNo} पर ई-सील टूटना। निरीक्षण हेतु रोकें।`,
      mr: `${e.containerNo} वर ई-सील तुटले. तपासणीसाठी थांबवा.`,
    }),
  },
};

export function eventToNotification(e: CargoEvent): Notification | null {
  const m = EVENT_MAP[e.eventType];
  if (!m) return null;
  return {
    notifId: `NTF-${e.eventType}-${(seq++).toString(36)}`,
    type: m.type,
    severity: m.severity,
    audienceRoles: m.audienceRoles,
    facilityId: e.facilityId,
    containerNo: e.containerNo,
    body: m.body(e),
    createdTs: e.ts,
  };
}

export class NotificationService {
  private store: Notification[] = [];
  private unsub?: () => void;

  constructor(private bus?: EventBus) {}

  /** Subscribe to the cargo-event topic and fan out notifications. */
  start(): void {
    if (!this.bus) return;
    this.unsub = this.bus.subscribe(TOPICS.cargoEvents, (ev: CloudEvent) => {
      const cargo = ev.data as CargoEvent;
      const n = eventToNotification(cargo);
      if (n) {
        this.store.push(n);
        this.bus?.publish(TOPICS.notifications, ev);
      }
    });
  }

  stop(): void {
    this.unsub?.();
  }

  /** Pre-seed from a batch of events (mock bootstrap). */
  ingestBatch(events: CargoEvent[], cap = 200): void {
    for (const e of events) {
      const n = eventToNotification(e);
      if (n) this.store.push(n);
      if (this.store.length >= cap) break;
    }
  }

  forRole(role: Role): Notification[] {
    return this.store.filter((n) => n.audienceRoles.includes(role));
  }

  ack(notifId: string, by: string, ts: string): boolean {
    const n = this.store.find((x) => x.notifId === notifId);
    if (!n) return false;
    n.ackBy = by;
    n.ackTs = ts;
    return true;
  }

  get all(): Notification[] {
    return this.store;
  }
}
