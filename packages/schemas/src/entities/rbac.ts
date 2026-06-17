/**
 * RBAC roles for the shared-data-platform (prompt §9). Each role gets scoped
 * data + a tailored dashboard view + only the notifications it should see.
 * Enforced at the gateway (claim-based) and in queries (row-level where
 * facility-scoped).
 */
export const ROLES = [
  'JNPA_MARINE',
  'JNPA_TRAFFIC',
  'TERMINAL_OPS',
  'CFS_OPERATOR',
  'ICD_OPERATOR',
  'CTO_RAIL',
  'CUSTOMS',
  'SHIPPING_LINE',
  'DTCCC_ADMIN',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles that are scoped to one or more facilities (row-level filtering applies).
 * DTCCC_ADMIN and the two JNPA roles see port-wide data; operators are scoped.
 */
export const FACILITY_SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'TERMINAL_OPS',
  'CFS_OPERATOR',
  'ICD_OPERATOR',
  'CTO_RAIL',
  'SHIPPING_LINE',
]);

/** Roles with port-wide (unscoped) read of operational data. */
export const PORT_WIDE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'JNPA_MARINE',
  'JNPA_TRAFFIC',
  'CUSTOMS',
  'DTCCC_ADMIN',
]);
