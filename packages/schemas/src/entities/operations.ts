import type {
  ContainerNo,
  FacilityType,
  Geometry,
  IsoUtc,
  SidingId,
} from './common.js';

// ---------------------------------------------------------------------------
// GateTransaction (§3) — drives gate-transaction-time + trailer TAT.
// ---------------------------------------------------------------------------

export type GateDirection = 'IN' | 'OUT';
export type GateOutcome = 'CLEARED' | 'HELD' | 'REJECTED';

export interface GateTransaction {
  gateTxnId: string;
  gateId: string;
  direction: GateDirection;
  vehicleNo: string;
  containerNo?: ContainerNo;
  /** Pre-booked appointment reference (links to UC3 trucking app slot). */
  appointmentRef?: string;
  /** Vehicle physically arrived at gate queue. */
  arrivalTs: IsoUtc;
  /** Transaction processing started. */
  startTs: IsoUtc;
  /** Transaction processing ended. */
  endTs?: IsoUtc;
  /** Codes of documents verified at the gate (e.g. ["FORM13","DO","ESEAL"]). */
  docsVerified: string[];
  outcome: GateOutcome;
}

// ---------------------------------------------------------------------------
// Facility (§3) — any node in the cargo network.
// ---------------------------------------------------------------------------

export interface Facility {
  facilityId: string;
  type: FacilityType;
  name: string;
  operator: string;
  /** Point or polygon in EPSG:4326. */
  geom: Geometry;
  /** Capacity in TEU where meaningful (terminals/CFS/ICD). */
  capacityTEU?: number;
  /** Live count of containers awaiting next move (pendency). */
  currentPendency: number;
}

// ---------------------------------------------------------------------------
// Terminal (§3) — config-driven container terminal with gates + siding mapping.
// ---------------------------------------------------------------------------

export type TosAccessMode = 'EDIFACT' | 'X12' | 'REST' | 'FILE_DROP';

export interface TerminalTosConfig {
  mode: TosAccessMode;
  /** EDIFACT directory version, e.g. "D21A" (when mode=EDIFACT). */
  ediVersion?: string;
  url?: string;
  dropDir?: string;
}

export interface Terminal {
  terminalId: string;
  name: string;
  operator: string;
  status: 'OPERATING' | 'TRANSITION' | 'CLOSED';
  geom: Geometry;
  quayLengthM?: number;
  capacityTEU?: number;
  /** Gate ids belonging to this terminal. */
  gates: string[];
  /** Rail sidings this terminal is mapped to (T1/T2). */
  sidings: SidingId[];
  /** How the twin talks to this terminal's TOS. */
  tos: TerminalTosConfig;
}

// ---------------------------------------------------------------------------
// Rake + Wagon (§3) — drive Rake TAT + Mixed-Train Optimization.
// ---------------------------------------------------------------------------

export type RakeDirection = 'INBOUND' | 'OUTBOUND';

export interface Rake {
  rakeId: string;
  /** Container Train Operator (CONCOR / private CTO). */
  ctoOperator: string;
  trainNo: string;
  /** FOIS reference for the rake. */
  foisRef: string;
  sidingId: SidingId;
  terminalId: string;
  /** Rake arrival at port rail yard. */
  arrivalTs: IsoUtc;
  /** Rake placed on siding (loading/unloading can begin). */
  placementTs?: IsoUtc;
  /** Rake removed from siding (work complete). */
  removalTs?: IsoUtc;
  /** Rake departed the yard. */
  departureTs?: IsoUtc;
  wagonCount: number;
  direction: RakeDirection;
  /** True if the rake carries mixed-terminal containers (drives ITRHO planning). */
  mixedFlag: boolean;
}

export interface Wagon {
  wagonId: string;
  rakeId: string;
  /** Position in the rake (1-based). */
  position: number;
  /** Container numbers loaded on this wagon. */
  containerNos: ContainerNo[];
}

// ---------------------------------------------------------------------------
// ITRHOMovement (§3) — inter-terminal handover; drives Inter-Terminal TAT +
// Transshipment Trailer TAT.
// ---------------------------------------------------------------------------

export type ItrhoMode = 'RAIL' | 'ROAD';

export interface ITRHOMovement {
  itrhoId: string;
  containerNo: ContainerNo;
  fromTerminalId: string;
  toTerminalId: string;
  /** Movement requested. */
  requestedTs: IsoUtc;
  /** Container handed out of origin terminal. */
  outTs?: IsoUtc;
  /** Container received at destination terminal. */
  inTs?: IsoUtc;
  mode: ItrhoMode;
}

// ---------------------------------------------------------------------------
// ScanEvent (§3) — customs/random scan; drives Scanner TAT.
// ---------------------------------------------------------------------------

export type ScanFlaggedBy = 'CUSTOMS' | 'RANDOM';
export type ScanResult = 'CLEAR' | 'HOLD' | 'EXAM';

export interface ScanEvent {
  scanId: string;
  containerNo: ContainerNo;
  scannerId: string;
  flaggedBy: ScanFlaggedBy;
  /** Scan queue-in (used as start of Scanner TAT). */
  startTs: IsoUtc;
  /** Scan cleared. */
  endTs?: IsoUtc;
  result?: ScanResult;
}
