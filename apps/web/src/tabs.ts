/**
 * The dashboard's tab registry — ids, labels and per-role visibility.
 *
 * Kept OUT of Dashboard.tsx so it can be imported without dragging in React,
 * Calcite and its stylesheet: this is data, and the architecture test asserts
 * against it directly (see test/tab-architecture.test.ts).
 *
 * Ordered by LIFECYCLE, not by when each tab was built.
 *
 * The two legs come first and each owns its own steps as sub-views: Import holds
 * IGM (1), the scan queue (5), OOC (6) and E-DO (7); Export holds the pre-advice
 * (2), Shipping Bill (5), LEO (6), the load list (7), COPRAR/COARRI (8–9) and
 * departures (10). The former `Customs` and `Scan` tabs are therefore gone —
 * their registers moved to the leg they belong to.
 *
 * Then the SHARED surfaces, which stay top-level because each serves both legs and
 * some roles need one without the other leg (a CFS operator reaches CFS/ECY without
 * being granted Export). The step strips link into them.
 *
 * Then the analysis/meta tabs, which are not part of any container's lifecycle.
 */
import type { Role } from '@jnpa/schemas';
import type { TabId } from './sim/scenarioPlayer.js';

export const TABS = [
  // — the two lifecycle spines —
  { id: 'import', label: 'Import' },
  { id: 'export', label: 'Export' },
  // — shared surfaces, reached by redirection from either strip —
  { id: 'gate', label: 'Gate' },
  { id: 'pendency', label: 'Pendency' },
  { id: 'rail', label: 'Rail T1/T2' },
  { id: 'itrho', label: 'ITRHO' },
  { id: 'empty', label: 'Empty' },
  { id: 'cfsecy', label: 'CFS/ECY' },
  { id: 'movements', label: 'Movements' },
  // — analysis & meta —
  { id: 'scenarios', label: 'What-If' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'models', label: 'AI Models' },
  { id: 'health', label: 'Integration' },
  { id: 'dataquality', label: 'Data Quality' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'methodology', label: 'Methodology' },
] as const;

/**
 * UI-only role → visible dashboard tabs (temporary mapping, pending business
 * confirmation). PRESENTATION FILTER ONLY — backend RBAC, API authorization and
 * role-based data scoping are unchanged; hidden tabs simply do not render.
 */
export const ROLE_TAB_IDS: Record<Role, readonly TabId[]> = {
  DTCCC_ADMIN: TABS.map((tb) => tb.id), // full access
  JNPA_MARINE: ['movements', 'gate', 'itrho', 'pendency', 'notifications', 'scenarios', 'methodology'],
  JNPA_TRAFFIC: ['import', 'export', 'gate', 'pendency', 'rail', 'itrho', 'cfsecy', 'movements', 'dataquality', 'notifications', 'scenarios', 'methodology'],
  TERMINAL_OPS: ['import', 'export', 'gate', 'pendency', 'rail', 'itrho', 'empty', 'cfsecy', 'movements', 'notifications', 'methodology'],
  // The customs registers now live inside the leg they belong to (IGM/OOC/E-DO in
  // Import; Shipping Bill/LEO in Export), so this role takes both legs where it
  // previously took the separate `igm` + `scan` tabs.
  // Data Quality is granted here because the findings are overwhelmingly customs
  // and manifest defects in JNPA's own source files — the people who can act on
  // "agency PAN stuffed into the IMO field" are the ones who read the documents.
  CUSTOMS: ['import', 'export', 'pendency', 'movements', 'dataquality', 'notifications', 'scenarios', 'methodology'],
  CTO_RAIL: ['movements', 'rail', 'itrho', 'pendency', 'notifications', 'methodology'],
  // CFS/ECY stays top-level precisely so these two reach it WITHOUT the export leg.
  ICD_OPERATOR: ['gate', 'pendency', 'rail', 'cfsecy', 'movements', 'notifications', 'methodology'],
  CFS_OPERATOR: ['import', 'gate', 'pendency', 'cfsecy', 'movements', 'notifications', 'methodology'],
  SHIPPING_LINE: ['export', 'empty', 'cfsecy', 'movements', 'notifications', 'methodology'],
};
