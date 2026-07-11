/**
 * SourceBadge — a small, consistent "Data Source" indicator placed near a
 * panel's toolbar. It names the panel's intended production source system
 * (derived from the existing project data — the simulator tags every event with
 * its real sourceSystem, see @jnpa/sim generators/cargo.ts) and, when the app is
 * running on the mock/simulator adapter, appends "Simulator (Mock)" so users
 * know the current data is simulated. Display-only; no new data or integration.
 */
import { CalciteIcon } from '@esri/calcite-components-react';
import { useApp } from '../state/AppContext.js';
import { tokens } from '../theme/tokens.js';

export function SourceBadge({ source, live }: { source: string; live?: boolean }) {
  const { adapter } = useApp();
  // `live` forces the badge to reflect a real backend regardless of the base
  // adapter mode — used by the Cargo panel, which is sourced from the POC-3
  // shared Cargo API even while the rest of the board runs on the simulator.
  const mock = !live && adapter.mode !== 'live';
  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 8px' }}
      title="Origin of the data shown in this panel"
    >
      <CalciteIcon icon="information" scale="s" />
      <span>Data Source: {source}{mock ? ' · Simulator (Mock)' : ''}</span>
    </div>
  );
}
