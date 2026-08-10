/**
 * Demo-console registry (Addendum B.3): "one console, three registries". Each
 * use-case registers its injectors + scenario triggers; the shared console UI
 * renders whatever is registered. UC2 registers the cargo injectors + the §8.2
 * S1–S6 scenarios. UC1/UC3 register their own against the same interface.
 */
export interface InjectorButton {
  id: string;
  label: string;
  group: 'event' | 'scenario' | 'cross-twin' | 'load';
  /** Optional keyboard shortcut (Addendum B.2 presenter ergonomics). */
  shortcut?: string;
  /** Parameters the control surface should collect (rendered as inputs). */
  params?: Array<{ key: string; label: string; type: 'number' | 'select'; options?: string[]; default?: number | string }>;
}

export interface FeedToggle {
  source: string; // ULIP, ICEGATE, TOS, FOIS, ESEAL, SHIPLINE
}

export interface DemoRunbook {
  id: string;
  label: string;
  durationLabel: '5-min' | '15-min';
  /** Ordered steps: injector/scenario ids to fire with delays (ms in virtual time). */
  steps: Array<{ injectorId: string; afterMs: number; params?: Record<string, unknown> }>;
}

export interface UseCaseRegistry {
  useCase: 'UC1' | 'UC2' | 'UC3';
  feeds: FeedToggle[];
  injectors: InjectorButton[];
  runbooks: DemoRunbook[];
}

/** UC2 registry (cargo injectors + §8.2 scenarios S1–S6). */
export const UC2_REGISTRY: UseCaseRegistry = {
  useCase: 'UC2',
  feeds: [
    { source: 'ULIP' },
    { source: 'ICEGATE' },
    { source: 'TOS' },
    { source: 'FOIS' },
    { source: 'ESEAL' },
    { source: 'SHIPLINE' },
  ],
  injectors: [
    { id: 'gateIn', label: 'Gate-In', group: 'event', shortcut: 'g' },
    { id: 'gateOutCodeco', label: 'Gate-Out (CODECO)', group: 'event', shortcut: 'o' },
    { id: 'scanFlag', label: 'Scan-Flag', group: 'event', shortcut: 's' },
    { id: 'damage', label: 'Damage', group: 'event', shortcut: 'd' },
    { id: 'esealBreak', label: 'E-seal Break', group: 'event', shortcut: 'b' },
    { id: 'leo', label: 'LEO', group: 'event', shortcut: 'l' },
    { id: 'rakeArrival', label: 'Rake Arrival', group: 'event', shortcut: 'r' },
    { id: 'itrhoOut', label: 'ITRHO Out', group: 'event' },
    { id: 'itrhoIn', label: 'ITRHO In', group: 'event' },
    // §8.2 named scenarios S1–S6 (superseding the old CGO-1/2/3 + LANE-ASSIGN).
    {
      id: 'S1', label: 'S1 · Rake Delay Cascade', group: 'scenario', shortcut: '1',
      params: [{ key: 'sidingId', label: 'Siding', type: 'select', options: ['T1', 'T2'], default: 'T1' }],
    },
    {
      id: 'S2', label: 'S2 · Customs Flag Surge → UC3', group: 'scenario', shortcut: '2',
      params: [
        { key: 'gateId', label: 'Gate', type: 'select', options: ['NSICT-G1', 'GTI-G2', 'BMCT-G1'], default: 'NSICT-G1' },
        { key: 'surgeCount', label: 'Surge count', type: 'number', default: 40 },
      ],
    },
    {
      id: 'S3', label: 'S3 · Mixed-Train Optimisation', group: 'scenario', shortcut: '3',
    },
    {
      id: 'S4', label: 'S4 · Gate Closure → Dynamic Lane', group: 'scenario', shortcut: '4',
      params: [{ key: 'gateId', label: 'Congested gate', type: 'select', options: ['NSICT-G1', 'GTI-G2', 'BMCT-G1'], default: 'NSICT-G1' }],
    },
    {
      id: 'S5', label: 'S5 · Trailer-Driver Shortage', group: 'scenario', shortcut: '5',
      params: [
        { key: 'facilityId', label: 'CFS', type: 'select', options: ['CFS-DRONAGIRI-1', 'CFS-URAN-1', 'CFS-PANVEL-1'], default: 'CFS-DRONAGIRI-1' },
        { key: 'shortagePct', label: 'Driver shortage %', type: 'number', default: 30 },
        { key: 'days', label: 'Duration (sim days)', type: 'number', default: 10 },
      ],
    },
    {
      id: 'S6', label: 'S6 · Reefer Surge', group: 'scenario', shortcut: '6',
      params: [{ key: 'failedPlugs', label: 'Failed CPP plugs', type: 'number', default: 18 }],
    },
    { id: 'crossTwinPush', label: 'Emit UC2→UC3 deferred-arrival', group: 'cross-twin' },
    { id: 'arrivalRate', label: 'Arrival rate', group: 'load', params: [{ key: 'rate', label: 'arrivals/hr', type: 'number', default: 20 }] },
  ],
  runbooks: [
    {
      id: 'demo-5', label: '5-minute walkthrough', durationLabel: '5-min',
      steps: [
        { injectorId: 'gateIn', afterMs: 0 },
        { injectorId: 'scanFlag', afterMs: 30000 },
        { injectorId: 'S2', afterMs: 60000, params: { gateId: 'NSICT-G1', surgeCount: 40 } },
        { injectorId: 'gateOutCodeco', afterMs: 120000 },
        { injectorId: 'S3', afterMs: 180000 },
      ],
    },
    {
      id: 'demo-15', label: '15-minute deep dive', durationLabel: '15-min',
      steps: [
        { injectorId: 'rakeArrival', afterMs: 0 },
        { injectorId: 'gateIn', afterMs: 30000 },
        { injectorId: 'damage', afterMs: 90000 },
        { injectorId: 'S5', afterMs: 180000, params: { facilityId: 'CFS-DRONAGIRI-1', shortagePct: 30, days: 10 } },
        { injectorId: 'scanFlag', afterMs: 300000 },
        { injectorId: 'S2', afterMs: 360000 },
        { injectorId: 'esealBreak', afterMs: 480000 },
        { injectorId: 'S4', afterMs: 600000 },
        { injectorId: 'S3', afterMs: 780000 },
      ],
    },
  ],
};
