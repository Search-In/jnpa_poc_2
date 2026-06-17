import type {
  ContainerNo,
  ContainerStatus,
  IsoTypeCode,
  IsoUtc,
  OriginStream,
} from './common.js';

/** Container size in feet (§3). */
export type ContainerSizeFt = 20 | 40 | 45;

/** Hazardous goods classification per IMDG (§3 Container.hazmatIMDG). */
export interface HazmatIMDG {
  /** IMDG class, e.g. "3" (flammable liquids), "8" (corrosives). */
  imdgClass: string;
  /** UN number, e.g. "1203". */
  unNo?: string;
  /** Packing group I/II/III. */
  packingGroup?: 'I' | 'II' | 'III';
}

/** Reefer temperature state (§3 Container.reefer). */
export interface ReeferState {
  /** Configured set-point temperature in Celsius. */
  setpointC: number;
  /** Last reported actual temperature in Celsius. */
  currentC: number;
}

/**
 * Container — the physical unit of cargo (prompt §3).
 * `containerNo` is the natural key (ISO 6346).
 */
export interface Container {
  /** ISO 6346 container number (natural key). */
  containerNo: ContainerNo;
  /** ISO 6346 size/type code, e.g. "22G1". */
  isoTypeCode: IsoTypeCode;
  /** Size in feet. */
  sizeFt: ContainerSizeFt;
  /** True if laden (carrying cargo), false if empty. */
  laden: boolean;
  /** Gross weight in kilograms. */
  grossWtKg: number;
  /** Free-text / coded cargo description. */
  cargoType: string;
  /** Present only if dangerous goods. */
  hazmatIMDG?: HazmatIMDG;
  /** Present only if a reefer container. */
  reefer?: ReeferState;
  /** Owning shipping line (line code, e.g. "MAEU"). */
  lineOwner: string;
  /** Current e-seal number affixed (updated by ESEAL_AFFIX events). */
  currentSealNo: string;
  /** Lifecycle status. */
  status: ContainerStatus;
  /** Stream of origin — drives role scoping + trans-shipment filters. */
  originStream: OriginStream;
  /** Last time any field on this projection changed (UTC). */
  lastUpdatedTs: IsoUtc;
}
