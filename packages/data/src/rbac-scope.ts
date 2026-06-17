/**
 * Row-level facility scoping for facility-scoped roles (prompt §9). This mirrors
 * the gateway's claim-based + row-level enforcement so the MockAdapter returns
 * the same scoped view the LiveAdapter would. The mapping from role → facility
 * types it may see is deliberate and documented.
 */
import type { Facility, Role } from '@jnpa/schemas';

/** Which facility types each scoped role is permitted to see. */
const ROLE_FACILITY_TYPES: Partial<Record<Role, Facility['type'][]>> = {
  TERMINAL_OPS: ['TERMINAL', 'RAIL_SIDING'],
  CFS_OPERATOR: ['CFS'],
  ICD_OPERATOR: ['ICD'],
  CTO_RAIL: ['RAIL_SIDING', 'TERMINAL'],
  SHIPPING_LINE: ['ECD'], // empty depots + their own containers (container-level handled separately)
};

/** Set of facilityIds a role may see (empty mapping ⇒ all, handled by caller). */
export function roleVisibleFacilityIds(role: Role, facilities: Facility[]): Set<string> {
  const types = ROLE_FACILITY_TYPES[role];
  if (!types) return new Set(facilities.map((f) => f.facilityId));
  return new Set(facilities.filter((f) => types.includes(f.type)).map((f) => f.facilityId));
}
