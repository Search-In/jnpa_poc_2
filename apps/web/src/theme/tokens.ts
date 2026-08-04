/**
 * Design tokens (prompt §14: "no colour literals outside tokens.ts"). Every
 * colour, severity hue, and traffic-light used by the dashboard and the map
 * renderers comes from here. Aligned to the Calcite dark theme.
 */
export const tokens = {
  color: {
    bg: '#f4f6f9',
    bgPanel: '#ffffff',
    bgElevated: '#eef1f5',
    border: '#d6dce4',
    text: '#1b1f27',
    textMuted: '#5b6675',
    brand: '#1a73c2',
    accent: '#0079c1',
  },
  // Health Card / degradation traffic lights (§6)
  degradation: {
    GREEN: '#2dbb6a',
    AMBER: '#f2a93b',
    RED: '#e04545',
  },
  // Integration mode badges (§6)
  mode: {
    LIVE: '#2dbb6a',
    CACHED: '#f2a93b',
    SYNTHETIC: '#7c8aff',
  },
  // Notification severity (§11)
  severity: {
    INFO: '#3aa0ff',
    WARN: '#f2a93b',
    CRIT: '#e04545',
  },
  // KPI improvement direction
  kpi: {
    better: '#2dbb6a',
    worse: '#e04545',
    neutral: '#9aa6b6',
  },
  // Facility-type unique values (Addendum A.1 Facilities layer)
  facility: {
    TERMINAL: '#1a73c2',
    CFS: '#00a3a3',
    ICD: '#7c8aff',
    DPE: '#c77dff',
    DPD: '#ff9e64',
    ECD: '#5bc8af',
    CPP: '#b0bec5',
    RAIL_SIDING: '#e0af68',
  },
  // Congestion class breaks (Addendum A.1 Port road network)
  congestion: {
    GREEN: '#2dbb6a',
    AMBER: '#f2a93b',
    RED: '#e04545',
  },
  // Cargo-flow stream colours (Addendum A.1 Cargo flows)
  flow: {
    IMPORT: '#3aa0ff',
    EXPORT: '#2dbb6a',
    TRANSSHIP: '#c77dff',
    ITRHO: '#ff9e64',
  },
  // NLDS / LDB inland-transit timeline (Manage → Track)
  track: {
    line: '#f0a818',
    node: '#1a73c2',
    nodeRing: '#ffffff',
    header: '#163a5f',
    subheader: '#5c6b7a',
    timestamp: '#c62828',
    infoBg: '#fff8e1',
    infoBorder: '#e8b923',
    duration: '#1b7a3d',
    durationBg: '#e7f6ec',
    railBg: '#f7f9fc',
    cardShadow: '0 1px 2px rgba(12,20,33,0.06), 0 8px 24px rgba(12,20,33,0.08)',
    modeBadge: '#e8f1fa',
  },
  /**
   * Categorical chart series, assigned in fixed order — never cycled, never
   * reassigned by rank. Validated as a categorical palette against the light
   * chart surface (#ffffff): lightness band, chroma floor, CVD separation
   * (worst adjacent pair ΔE 24.0 protan / 27.3 tritan), normal-vision floor
   * (ΔE 29.6) and ≥3:1 contrast all pass. Re-run the check before adding a
   * third slot; do not pick one by eye.
   */
  series: {
    A: '#1a73c2',
    B: '#c2610a',
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 4, md: 8 },
} as const;

export type Tokens = typeof tokens;
