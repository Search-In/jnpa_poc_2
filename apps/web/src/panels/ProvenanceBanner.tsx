/**
 * Per-screen provenance banner (ticket UC2-064).
 *
 * The header used to carry one word for the whole board, taken from
 * `adapter.mode`. That word is wrong on every screen, because the board is
 * genuinely mixed: deployed, the base adapter is the simulator (CI never sets
 * `VITE_DATA_MODE`) while `VITE_CARGO_SOURCE` defaults to `poc3`, so Import,
 * Export, Movements, CFS/ECY and Data Quality serve the real ingested corpus.
 * A viewer reading SIMULATED in the header and "Data Source: ICEGATE · CHPOI03"
 * two inches below it cannot tell which one to believe.
 *
 * This states what THIS screen is, changing as the tab changes, and expands to
 * the whole board on demand. It sits above the tabs rather than inside each
 * panel so it cannot be forgotten when a panel is added — the map in
 * `state/provenance.ts` is checked against the tab registry by test.
 *
 * It deliberately does not replace the per-panel `SourceBadge`. That names the
 * production source system for a specific table; this names what is serving the
 * screen right now. Both are true and they answer different questions.
 */
import { useState } from 'react';
import { CalciteIcon } from '@esri/calcite-components-react';
import type { TabId } from '../sim/scenarioPlayer.js';
import {
  boardSummary, provenanceTone, screenProvenance,
  type Provenance, type ProvenanceContext, type ScreenProvenance,
} from '../state/provenance.js';
import { tokens } from '../theme/tokens.js';

const LABEL: Record<Provenance, string> = {
  REAL: 'Real data',
  MIXED: 'Mixed',
  SIMULATED: 'Simulated',
  BROWSER: 'This browser only',
  STATIC: 'Document',
};

function toneColor(p: Provenance): string {
  const tone = provenanceTone(p);
  if (tone === 'good') return tokens.degradation.GREEN;
  if (tone === 'warn') return tokens.degradation.AMBER;
  return tokens.color.textMuted;
}

function Pill({ p }: { p: Provenance }) {
  return (
    <span style={{
      fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4,
      padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap',
      border: `1px solid ${toneColor(p)}`, color: toneColor(p),
    }}>
      {LABEL[p]}
    </span>
  );
}

/** The named halves of a mixed screen — the part that makes MIXED useful. */
function Halves({ s }: { s: ScreenProvenance }) {
  if (!s.real && !s.simulated) return null;
  return (
    <span style={{ color: tokens.color.textMuted }}>
      {s.real && <> · <strong style={{ color: tokens.degradation.GREEN }}>real:</strong> {s.real}</>}
      {s.simulated && <> · <strong style={{ color: tokens.color.textMuted }}>simulated:</strong> {s.simulated}</>}
    </span>
  );
}

export function ProvenanceBanner({ activeTab, ctx }: { activeTab: TabId; ctx: ProvenanceContext }) {
  const [open, setOpen] = useState(false);
  const screens = screenProvenance(ctx);
  const here = screens.find((s) => s.tab === activeTab);
  const summary = boardSummary(screens);
  if (!here) return null;

  return (
    <div style={{
      margin: '0 12px', padding: '6px 10px', borderRadius: 6,
      border: `1px solid ${tokens.color.border}`, background: tokens.color.bgElevated,
      fontSize: 11.5, lineHeight: 1.45,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pill p={here.provenance} />
        <span style={{ color: tokens.color.text }}>{here.summary}</span>
        <Halves s={here} />
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
            color: tokens.color.brand, fontSize: 11.5, display: 'inline-flex',
            alignItems: 'center', gap: 4, whiteSpace: 'nowrap', padding: 0,
          }}
          aria-expanded={open}
        >
          {summary.label} · {summary.real} real · {summary.simulated + summary.mixed} not
          <CalciteIcon icon={open ? 'chevron-up' : 'chevron-down'} scale="s" />
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 8 }}>
          <div style={{ color: tokens.color.textMuted, marginBottom: 6 }}>{summary.detail}</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {screens.map((s) => (
              <div key={s.tab} style={{ display: 'grid', gridTemplateColumns: '108px 92px 1fr', gap: 8 }}>
                <strong style={{
                  color: s.tab === activeTab ? tokens.color.brand : tokens.color.text,
                  textTransform: 'capitalize',
                }}>
                  {s.tab}
                </strong>
                <Pill p={s.provenance} />
                <span style={{ color: tokens.color.textMuted }}>
                  {s.summary}<Halves s={s} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
