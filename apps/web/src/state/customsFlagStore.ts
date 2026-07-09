/**
 * customsFlagStore — customs-scan flags raised MANUALLY from the Container
 * Movements tab. Each flag becomes a real `CUSTOMS_SCANNER_FLAG` Notification
 * (reusing @jnpa/schemas, same type/severity/audience as the simulator-derived
 * customs notifications) and is shown in the Notifications Centre alongside them.
 * Client-only session state; mirrors the existing store pattern (simStore) —
 * subscribe + a useSyncExternalStore snapshot. No backend/API change.
 */
import { useSyncExternalStore } from 'react';
import type { Notification, Role } from '@jnpa/schemas';

// Same audience the event-derived CUSTOMS_SCANNER_FLAG uses (notifications-derive.ts).
const AUDIENCE: Role[] = ['CUSTOMS', 'TERMINAL_OPS', 'DTCCC_ADMIN'];

let seq = 0;
let flags: Notification[] = [];
const listeners = new Set<() => void>();

export const customsFlagStore = {
  getSnapshot: (): Notification[] => flags,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Raise a customs-scan flag for a container (no-op if already flagged). */
  flagForCustoms(containerNo: string, facilityId?: string): void {
    if (flags.some((f) => f.containerNo === containerNo)) return;
    const n: Notification = {
      notifId: `NTF-CUSTOMS-MANUAL-${(seq++).toString(36)}`,
      type: 'CUSTOMS_SCANNER_FLAG',
      severity: 'WARN',
      audienceRoles: AUDIENCE,
      ...(facilityId ? { facilityId } : {}),
      containerNo,
      body: {
        en: `Container ${containerNo} manually flagged for customs scan${facilityId ? ` at ${facilityId}` : ''}.`,
        hi: `कंटेनर ${containerNo} को सीमा शुल्क स्कैन हेतु मैन्युअल रूप से चिह्नित किया गया।`,
        mr: `कंटेनर ${containerNo} सीमाशुल्क स्कॅनसाठी स्वहस्ते चिन्हांकित.`,
      },
      createdTs: new Date().toISOString(),
    };
    flags = [n, ...flags];
    listeners.forEach((l) => l());
  },
};

/** Manual customs flags visible to `role` (audience-scoped, like getNotifications). */
export function useCustomsFlags(role: Role): Notification[] {
  const all = useSyncExternalStore(customsFlagStore.subscribe, customsFlagStore.getSnapshot, customsFlagStore.getSnapshot);
  return all.filter((n) => n.audienceRoles.includes(role));
}
