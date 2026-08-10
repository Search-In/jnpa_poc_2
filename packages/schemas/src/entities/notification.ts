import type { ContainerNo, IsoUtc, SourceSystem } from './common.js';
import type { Role } from './rbac.js';

/**
 * Notification types (prompt §11 + Appendix C intended-use 2 + bid §8.4.4).
 * The first seven are the explicitly-listed operational notifications; the last
 * four are the anomaly alerts from §7.4 (event-anomaly detector).
 */
export const NOTIFICATION_TYPES = [
  'GATE_IN',
  'GATE_OUT', // CODECO
  'SPECIAL_INSTRUCTION',
  'CUSTOMS_SCANNER_FLAG', // EDI
  'DAMAGE_ASSESSMENT',
  'CONTAINER_PENDENCY', // CFS/ICD-wise
  'GATE_QUEUE_STATUS',
  // anomaly alerts (§7.4)
  'ANOMALY_MISSING_GATE_OUT',
  'ANOMALY_LEO_NO_MOVE',
  'ANOMALY_SCAN_FLAG_NO_SCAN',
  'ANOMALY_SEQUENCE',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type Severity = 'INFO' | 'WARN' | 'CRIT';

/** Multilingual body (prompt §1 i18n: Hindi / English / Marathi). */
export interface MultilingualBody {
  en: string;
  hi: string;
  mr: string;
}

export interface Notification {
  notifId: string;
  type: NotificationType;
  severity: Severity;
  /** Roles that should receive this notification. */
  audienceRoles: Role[];
  /** Facility context, for row-level scoping. */
  facilityId?: string;
  /** Container context, where relevant. */
  containerNo?: ContainerNo;
  body: MultilingualBody;
  createdTs: IsoUtc;
  /** Set when a user acknowledges. */
  ackBy?: string;
  ackTs?: IsoUtc;
}

// ---------------------------------------------------------------------------
// IntegrationHealth (§3, §6) — per-source Health Card backing data.
// ---------------------------------------------------------------------------

/** Degradation traffic-light for a connector. */
export type Degradation = 'GREEN' | 'AMBER' | 'RED';

/** Which tier of the fallback chain is currently serving (§6). */
export type IntegrationMode = 'LIVE' | 'CACHED' | 'SYNTHETIC';

export interface IntegrationHealth {
  sourceSystem: SourceSystem;
  /** Last successful poll of the live source (UTC). */
  lastGoodPollTs?: IsoUtc;
  errorCount: number;
  degradation: Degradation;
  mode: IntegrationMode;
  /** Optional human note shown on the Operator Banner. */
  note?: string;
  /**
   * WHICH thing produced this card (UC2-040).
   *
   * `CONNECTOR` — a real connector service answered `GET /health`.
   * `SIMULATED` — the in-browser fault console produced it because no connector
   *               was reachable.
   *
   * ⚠ `mode` and `source` answer DIFFERENT questions and must not be conflated.
   * `mode` is which tier of the connector's OWN fallback chain is serving
   * (LIVE → CACHED → SYNTHETIC); `source` is whether a connector was involved at
   * all. A card can legitimately read `mode: SYNTHETIC, source: CONNECTOR` — a
   * real service honestly reporting that it is running on simulated data. What
   * must never happen again is `source: SIMULATED` presented as if a connector
   * had spoken.
   *
   * Optional so a build that has not been wired to connectors still typechecks;
   * absent is read as SIMULATED by the UI.
   */
  source?: 'CONNECTOR' | 'SIMULATED';
  /** Why no connector answered, when `source` is SIMULATED. Shown, not logged. */
  fallbackReason?: string;
}
