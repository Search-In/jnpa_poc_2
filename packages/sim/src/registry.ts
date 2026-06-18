/**
 * Demo-console registry (Addendum B.3): "one console, three registries". Each
 * use-case registers its injectors + scenario triggers; the shared console UI
 * renders whatever is registered. UC2 registers the cargo injectors + CGO-1/2/3
 * + congestion/lane sim. UC1/UC3 register their own against the same interface.
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

/** UC2 registry (cargo injectors + CGO-1/2/3 + congestion/lane). */
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
    {
      id: 'CGO-1', label: 'CGO-1 · CFS Pendency Spike', group: 'scenario', shortcut: '1',
      params: [
        { key: 'facilityId', label: 'CFS', type: 'select', options: ['CFS-PUNE', 'CFS-DRONAGIRI', 'CFS-PANVEL'], default: 'CFS-PUNE' },
        { key: 'threshold', label: 'Pendency threshold', type: 'number', default: 50 },
      ],
    },
    {
      id: 'CGO-2', label: 'CGO-2 · Customs Surge → UC3', group: 'scenario', shortcut: '2',
      params: [
        { key: 'gateId', label: 'Gate', type: 'select', options: ['NSICT-G1', 'GTI-G2', 'BMCT-G1'], default: 'NSICT-G1' },
        { key: 'surgeCount', label: 'Surge count', type: 'number', default: 40 },
      ],
    },
    {
      id: 'CGO-3', label: 'CGO-3 · ITRHO Optimisation', group: 'scenario', shortcut: '3',
    },
    {
      id: 'LANE-ASSIGN', label: 'Congestion → Lane Assignment', group: 'scenario', shortcut: '4',
      params: [{ key: 'gateId', label: 'Congested gate', type: 'select', options: ['GTI-G2', 'NSICT-G1', 'BMCT-G2'], default: 'GTI-G2' }],
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
        { injectorId: 'CGO-2', afterMs: 60000, params: { gateId: 'NSICT-G1', surgeCount: 40 } },
        { injectorId: 'gateOutCodeco', afterMs: 120000 },
        { injectorId: 'CGO-3', afterMs: 180000 },
      ],
    },
    {
      id: 'demo-15', label: '15-minute deep dive', durationLabel: '15-min',
      steps: [
        { injectorId: 'rakeArrival', afterMs: 0 },
        { injectorId: 'gateIn', afterMs: 30000 },
        { injectorId: 'damage', afterMs: 90000 },
        { injectorId: 'CGO-1', afterMs: 180000, params: { facilityId: 'CFS-PUNE', threshold: 50 } },
        { injectorId: 'scanFlag', afterMs: 300000 },
        { injectorId: 'CGO-2', afterMs: 360000 },
        { injectorId: 'esealBreak', afterMs: 480000 },
        { injectorId: 'LANE-ASSIGN', afterMs: 600000 },
        { injectorId: 'CGO-3', afterMs: 780000 },
      ],
    },
  ],
};
