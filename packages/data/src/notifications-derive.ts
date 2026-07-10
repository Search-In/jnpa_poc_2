/**
 * Derive the §11 notification set from the dataset. In live operation the
 * notifications service produces these from the event stream; in mock mode we
 * derive them deterministically so the Notifications Centre is populated offline.
 * Bodies are multilingual (en/hi/mr) per §1 i18n.
 */
import type { CargoEvent, Notification, NotificationType, Role, Severity } from '@jnpa/schemas';
import type { CargoDataset, World } from '@jnpa/sim';

let counter = 0;
const nid = (seed: string) => `NTF-${seed}-${(counter++).toString(36)}`;

function notif(
  type: NotificationType,
  severity: Severity,
  audienceRoles: Role[],
  body: { en: string; hi: string; mr: string },
  e: { containerNo?: string; facilityId?: string; ts: string },
): Notification {
  return {
    notifId: nid(type),
    type,
    severity,
    audienceRoles,
    facilityId: e.facilityId,
    containerNo: e.containerNo,
    body,
    createdTs: e.ts,
  };
}

export function buildNotifications(dataset: CargoDataset, _world: World): Notification[] {
  counter = 0;
  const out: Notification[] = [];
  const events = dataset.events;

  const byType = (t: CargoEvent['eventType']) => events.filter((e) => e.eventType === t);

  // CUSTOMS_SCANNER_FLAG (cap to a recent sample for the panel)
  for (const e of byType('CUSTOMS_FLAG').slice(0, 12)) {
    out.push(
      notif(
        'CUSTOMS_SCANNER_FLAG',
        'WARN',
        ['CUSTOMS', 'TERMINAL_OPS', 'CFS_OPERATOR', 'ICD_OPERATOR', 'DTCCC_ADMIN'],
        {
          en: `Container ${e.containerNo} flagged for customs scan at ${e.facilityId}.`,
          hi: `कंटेनर ${e.containerNo} को ${e.facilityId} पर सीमा शुल्क स्कैन हेतु चिह्नित किया गया।`,
          mr: `कंटेनर ${e.containerNo} ${e.facilityId} येथे सीमाशुल्क स्कॅनसाठी चिन्हांकित.`,
        },
        e,
      ),
    );
  }

  // DAMAGE_ASSESSMENT
  for (const e of byType('DAMAGE_FLAG').slice(0, 8)) {
    out.push(
      notif(
        'DAMAGE_ASSESSMENT',
        'CRIT',
        ['TERMINAL_OPS', 'SHIPPING_LINE', 'CFS_OPERATOR', 'ICD_OPERATOR', 'DTCCC_ADMIN'],
        {
          en: `Damage reported on ${e.containerNo} at ${e.facilityId}. Inspection required.`,
          hi: `${e.facilityId} पर ${e.containerNo} में क्षति की सूचना। निरीक्षण आवश्यक।`,
          mr: `${e.facilityId} येथे ${e.containerNo} वर नुकसान नोंदवले. तपासणी आवश्यक.`,
        },
        e,
      ),
    );
  }

  // GATE_IN / GATE_OUT (small recent sample — high volume otherwise)
  for (const e of byType('GATE_IN').slice(0, 6)) {
    out.push(
      notif(
        'GATE_IN',
        'INFO',
        ['TERMINAL_OPS', 'CFS_OPERATOR', 'ICD_OPERATOR', 'CTO_RAIL', 'JNPA_TRAFFIC', 'JNPA_MARINE', 'DTCCC_ADMIN'],
        {
          en: `Gate-in: ${e.containerNo} at ${e.gateId ?? e.facilityId}.`,
          hi: `गेट-इन: ${e.gateId ?? e.facilityId} पर ${e.containerNo}।`,
          mr: `गेट-इन: ${e.gateId ?? e.facilityId} येथे ${e.containerNo}.`,
        },
        e,
      ),
    );
  }
  for (const e of byType('GATE_OUT').slice(0, 6)) {
    out.push(
      notif(
        'GATE_OUT',
        'INFO',
        ['TERMINAL_OPS', 'CFS_OPERATOR', 'ICD_OPERATOR', 'CTO_RAIL', 'JNPA_TRAFFIC', 'JNPA_MARINE', 'DTCCC_ADMIN'],
        {
          en: `Gate-out (CODECO): ${e.containerNo} cleared at ${e.gateId ?? e.facilityId}.`,
          hi: `गेट-आउट (CODECO): ${e.gateId ?? e.facilityId} पर ${e.containerNo} मुक्त।`,
          mr: `गेट-आउट (CODECO): ${e.gateId ?? e.facilityId} येथे ${e.containerNo} मुक्त.`,
        },
        e,
      ),
    );
  }

  // ESEAL_BREAK → SPECIAL_INSTRUCTION (tamper) + anomaly
  for (const e of byType('ESEAL_BREAK').slice(0, 5)) {
    out.push(
      notif(
        'SPECIAL_INSTRUCTION',
        'CRIT',
        ['CUSTOMS', 'TERMINAL_OPS', 'CFS_OPERATOR', 'ICD_OPERATOR', 'DTCCC_ADMIN'],
        {
          en: `E-seal break detected on ${e.containerNo}. Hold for inspection.`,
          hi: `${e.containerNo} पर ई-सील टूटना पाया गया। निरीक्षण हेतु रोकें।`,
          mr: `${e.containerNo} वर ई-सील तुटल्याचे आढळले. तपासणीसाठी थांबवा.`,
        },
        e,
      ),
    );
  }

  return out;
}
