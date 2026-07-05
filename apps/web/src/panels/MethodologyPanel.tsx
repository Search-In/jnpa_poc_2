/**
 * Methodology & Assumptions panel (spec §1 + §9, scored criterion 1 — "Solution
 * approach / methodology, assumptions made"). A first-class, in-app surface that
 * makes the deliverable artifacts visible to the committee:
 *   1. Solution approach (one-paragraph + demo→production mapping),
 *   2. Assumptions Register — every KPI baseline with value, scope, source and
 *      justification, rendered straight from config/baselines.json (an evaluator
 *      can edit that file and the table changes, no code change),
 *   3. Real-world grounding pack from seed/jnpa_grounding.json (public sources),
 *   4. Open-source inventory (name + license + role — nothing claimed as
 *      from-scratch invention),
 *   5. DATA_MODE legend + determinism note.
 *
 * Framing discipline: every figure is labelled SIMULATED / ASSUMED — no claimed
 * JNPA baselines.
 */
import type React from 'react';
import { CalciteCard, CalciteChip, CalciteNotice } from '@esri/calcite-components-react';
import { useApp } from '../state/AppContext.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import baselinesConfig from '../../../../config/baselines.json';
import grounding from '../../../../seed/jnpa_grounding.json';

interface BaselineEntry {
  value: number;
  unit: string;
  scope: string;
  source: string;
  justification: string;
}

/** OSS components (name + license + role) — spec §1.3 honest positioning. */
const OSS: Array<{ name: string; license: string; role: string }> = [
  { name: 'ArcGIS Maps SDK for JavaScript (@arcgis/core 4.x)', license: 'Esri-licensed', role: '2D/3D map + SceneView' },
  { name: 'Calcite Design System (@esri/calcite-components 3.x)', license: 'Esri-licensed (Apache-2.0 components)', role: 'Dark UI shell / widgets' },
  { name: 'React 18', license: 'MIT', role: 'UI framework' },
  { name: 'TypeScript', license: 'Apache-2.0', role: 'Typed contracts across the monorepo' },
  { name: 'Vite', license: 'MIT', role: 'Build / dev server' },
  { name: 'AJV (2020 dialect)', license: 'MIT', role: 'JSON-Schema validation of event contracts' },
  { name: 'FastAPI', license: 'MIT', role: 'Python REST/WebSocket services (gateway, ML, connectors)' },
  { name: 'scikit-learn', license: 'BSD-3-Clause', role: 'HistGradientBoosting ML models (rake TAT, gate queue, dwell, anomaly)' },
  { name: 'Redis', license: 'BSD-3-Clause', role: 'Event backbone (Redis Streams) + cache' },
  { name: 'PostgreSQL + TimescaleDB', license: 'PostgreSQL / Timescale License', role: 'Event + telemetry store' },
];

/** Demo → production mapping (spec §3, §9). */
const DEMO_PROD: Array<{ concern: string; demo: string; production: string }> = [
  { concern: 'Event backbone', demo: 'Redis Streams (laptop-light)', production: 'Kafka + medallion lakehouse (Bronze/Silver/Gold), same topic taxonomy' },
  { concern: 'Data sources', demo: 'Simulated adapters (Integration Console)', production: 'Live TOS ×5 / FOIS / ICEGATE / e-Seal / ULIP feeds, same contracts' },
  { concern: 'ML training data', demo: 'Synthetic, JNPA-scale', production: 'Retrained on live TOS/FOIS/ICEGATE feeds during implementation' },
  { concern: 'Port geometry', demo: 'Schematic geojson (recognisable fidelity)', production: 'LiDAR + orthophoto survey per Annexure 16' },
  { concern: 'Basemap', demo: 'ArcGIS online + bundled offline fallback', production: 'JNPA WebMap / enterprise ArcGIS' },
];

function sourceChipKind(source: string): 'brand' | 'neutral' | 'inverse' {
  if (source.startsWith('ASSUMED')) return 'inverse';
  if (source.includes('public') || source.includes('JNPA') || source.includes('tender')) return 'brand';
  return 'neutral';
}

export function MethodologyPanel() {
  const { lang } = useApp();
  const baselines = (baselinesConfig as { baselines: Record<string, BaselineEntry> }).baselines;
  const state = { data: Object.entries(baselines), loading: false, error: null };

  return (
    <Panel heading="Methodology & Assumptions" state={state} isEmpty={() => false}>
      {(entries) => (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Framing banner */}
          <CalciteNotice open icon="information" kind="brand" scale="s">
            <div slot="title">How to read every number in this twin</div>
            <div slot="message">
              All figures are <strong>SIMULATED</strong> results under stated assumptions or public-source
              calibration — never claimed JNPA baselines. The tender directs bidders to "make relevant
              assumptions and clearly list them"; this panel is that register.
            </div>
          </CalciteNotice>

          {/* 1. Solution approach */}
          <section>
            <h3 style={hStyle}>Solution approach</h3>
            <p style={pStyle}>
              A discrete-event digital twin of JNPA cargo handling: a seeded simulation engine drives
              synthetic-but-calibrated operations; every KPI is computed from the same engine that the
              What-If scenarios run through (twin-vs-shadow A/B). External integrations are locally
              simulated adapters with identical contracts, so the demo runs fully offline and degrades
              gracefully when a source is taken down.
            </p>
          </section>

          {/* 2. Assumptions register (from baselines.json) */}
          <section>
            <h3 style={hStyle}>Assumptions register — KPI baselines</h3>
            <p style={{ ...pStyle, marginBottom: 8 }}>
              Editable in <code>config/baselines.json</code> — an evaluator can override any value without a code change.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>{['KPI', 'Value', 'Unit', 'Scope', 'Source', 'Justification'].map((h) => (<th key={h} style={thStyle}>{h}</th>))}</tr>
                </thead>
                <tbody>
                  {entries.map(([key, b]) => (
                    <tr key={key}>
                      <td style={tdStyle}><strong>{key}</strong></td>
                      <td style={tdStyle}>{b.value}</td>
                      <td style={tdStyle}>{b.unit}</td>
                      <td style={{ ...tdStyle, color: tokens.color.textMuted }}>{b.scope}</td>
                      <td style={tdStyle}><CalciteChip scale="s" kind={sourceChipKind(b.source)} value={b.source}>{b.source}</CalciteChip></td>
                      <td style={{ ...tdStyle, color: tokens.color.textMuted, minWidth: 240 }}>{b.justification}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 3. Real-world grounding pack (from seed/jnpa_grounding.json) */}
          <section>
            <h3 style={hStyle}>Real-world grounding (public sources)</h3>
            <p style={{ ...pStyle, marginBottom: 8 }}>
              Public figures used only to calibrate the simulation so the twin is recognisably JNPA — from <code>seed/jnpa_grounding.json</code>.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {grounding.terminals.map((tm) => (
                <CalciteCard key={tm.id} style={{ minWidth: 200 }}>
                  <div slot="heading" style={{ fontSize: 13 }}>{tm.id}{'aka' in tm && tm.aka ? ` (${tm.aka})` : ''}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: tokens.color.text }}>
                    {tm.teuFy2425}<span style={{ fontSize: 12, color: tokens.color.textMuted }}> M TEU · {tm.sharePct}%</span>
                  </div>
                  <div slot="footer-start" style={{ fontSize: 10.5, color: tokens.color.textMuted }}>{tm.source}</div>
                </CalciteCard>
              ))}
            </div>
            <p style={{ ...pStyle, marginTop: 8 }}>
              Port total {grounding.port.totalTeuFy2425.value} {grounding.port.totalTeuFy2425.unit} (FY24-25).
              CPP: {grounding.landside.cpp.areaHa} ha, {grounding.landside.cpp.trailerCapacity} trailers, {grounding.landside.cpp.weighbridgeGates} gates, {grounding.landside.cpp.reeferPlugs} reefer plugs.
              BMCT sits ~5.5 km from the older cluster — the raison d'être of ITRHO (operational since Aug 2019).
            </p>
          </section>

          {/* 4. Open-source inventory */}
          <section>
            <h3 style={hStyle}>Open-source &amp; OEM inventory</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead><tr>{['Component', 'License', 'Role'].map((h) => (<th key={h} style={thStyle}>{h}</th>))}</tr></thead>
                <tbody>
                  {OSS.map((o) => (
                    <tr key={o.name}>
                      <td style={tdStyle}>{o.name}</td>
                      <td style={tdStyle}><CalciteChip scale="s" kind="neutral" value={o.license}>{o.license}</CalciteChip></td>
                      <td style={{ ...tdStyle, color: tokens.color.textMuted }}>{o.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 5. Demo → production mapping */}
          <section>
            <h3 style={hStyle}>Demo → production mapping</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead><tr>{['Concern', 'This demo', 'Production'].map((h) => (<th key={h} style={thStyle}>{h}</th>))}</tr></thead>
                <tbody>
                  {DEMO_PROD.map((d) => (
                    <tr key={d.concern}>
                      <td style={tdStyle}><strong>{d.concern}</strong></td>
                      <td style={{ ...tdStyle, color: tokens.color.textMuted }}>{d.demo}</td>
                      <td style={{ ...tdStyle, color: tokens.color.textMuted }}>{d.production}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 6. DATA_MODE legend + determinism */}
          <section>
            <h3 style={hStyle}>Data mode &amp; determinism</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <CalciteChip scale="s" kind="neutral" value="SIMULATED">SIMULATED — synthetic engine (this demo default)</CalciteChip>
              <CalciteChip scale="s" kind="neutral" value="REPLAY">REPLAY — synthetic historical</CalciteChip>
              <CalciteChip scale="s" kind="brand" value="LIVE">LIVE — real feed (production)</CalciteChip>
            </div>
            <p style={pStyle}>
              The simulation is deterministic under a fixed seed (world geometry seed 42; dataset seed 20260615),
              so the live demo is repeatable and rehearsable; a free-run mode is available for Q&amp;A.
              Lang: {t('appTitle', lang)}.
            </p>
          </section>
        </div>
      )}
    </Panel>
  );
}

const hStyle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: tokens.color.text, margin: '0 0 6px' };
const pStyle: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.5, color: tokens.color.textMuted, margin: 0 };
const tableStyle: React.CSSProperties = { borderCollapse: 'collapse', width: '100%', fontSize: 12 };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', borderBottom: `2px solid ${tokens.color.border}`, color: tokens.color.textMuted, whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '6px 10px', borderBottom: `1px solid ${tokens.color.border}`, verticalAlign: 'top' };
