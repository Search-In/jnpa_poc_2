import type { ContainerNo, IsoUtc } from './common.js';

/**
 * ShippingDoc (§3) — line/customs documents that gate cargo movement.
 *  - IAL/EAL = Import/Export Advice List (shipping line)
 *  - DO      = Delivery Order
 *  - BE      = Bill of Entry (import customs)
 *  - SB      = Shipping Bill (export customs)
 *  - FORM13  = JNPA Form-13 gate-pass
 */
export type ShippingDocType = 'IAL' | 'EAL' | 'DO' | 'BE' | 'SB' | 'FORM13';

export interface ShippingDoc {
  docId: string;
  type: ShippingDocType;
  containerNos: ContainerNo[];
  /** Issuing line code (for IAL/EAL/DO) or customs house (for BE/SB). */
  lineId: string;
  issuedTs: IsoUtc;
  /** Native document fields, normalised. */
  payload: Record<string, unknown>;
}

/**
 * EmptyPool (§3) — empty-container availability per line/depot vs projected
 * demand. Drives empty-container visibility for CFS planning (§10).
 */
export interface EmptyPool {
  lineId: string;
  /** Empty container depot id (a Facility of type ECD). */
  depotId: string;
  availableQty: number;
  projectedDemandQty: number;
  asOfTs: IsoUtc;
}
