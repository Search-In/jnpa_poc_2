/**
 * YardBackendPlanning — the POC-3 Yard Planning, Yard Optimization and Reefer
 * Planning integration (Jayesh handover), rendered as an additive section inside
 * the existing Pendency (yard) tab. Backs UC-II requirement 5 ("yard planning &
 * operations optimization to reduce TAT/pendency"):
 *
 *   GET  /api/cargo/yard-optimization → congestion, priority containers, moves
 *   POST /api/cargo/yard-planning     → allocate a planned yard position
 *   POST /api/cargo/reefer-planning   → allocate a reefer slot (temp/power)
 *
 * POC-3 owns the optimization/allocation logic; this is a thin consumer. It is
 * purely additive — the existing pendency table and the local "Yard planning
 * info" workflow drawer are untouched. Degrades gracefully when the Cargo API is
 * not the active data source (mock/sim mode → the whole section hides itself).
 */
import { useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteInput, CalciteLabel, CalciteLoader, CalciteNotice,
  CalciteOption, CalciteSelect,
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
} from '@esri/calcite-components-react';
import type { ContainerMovementDTO, YardOptimization } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { SuccessNotice, type SuccessDetail } from '../components/SuccessNotice.js';
import { tokens } from '../theme/tokens.js';

/** A form message: an error string, or a standardized success (title + detail rows). */
type FormMsg =
  | { kind: 'danger'; text: string }
  | { kind: 'success'; title: string; details: SuccessDetail[] };

const sectionHead: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: tokens.color.textMuted,
  textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px',
};

/**
 * A dropdown backed by a dynamically-loaded option list (containers / yard blocks
 * from the existing backend, never hardcoded). Falls back to a disabled "no
 * options" placeholder when the list is empty so the picker degrades gracefully.
 */
function Picker({
  label, value, options, placeholder, onChange, minWidth = 160,
}: {
  label: string; value: string; options: string[]; placeholder: string;
  onChange: (v: string) => void; minWidth?: number;
}) {
  return (
    <CalciteLabel scale="s" style={{ flex: 1, minWidth }}>{label}
      <CalciteSelect
        label={label}
        scale="s"
        disabled={options.length === 0}
        onCalciteSelectChange={(e) => onChange((e.target as unknown as { value: string }).value)}
      >
        <CalciteOption value="" selected={value === ''}>
          {options.length === 0 ? `No ${placeholder} available` : `Select ${placeholder}…`}
        </CalciteOption>
        {options.map((o) => (
          <CalciteOption key={o} value={o} selected={o === value}>{o}</CalciteOption>
        ))}
      </CalciteSelect>
    </CalciteLabel>
  );
}

const congestionColor = (level?: string, util?: number) => {
  const l = (level ?? '').toUpperCase();
  if (l.includes('HIGH') || l.includes('RED') || (util ?? 0) >= 0.85) return tokens.congestion.RED;
  if (l.includes('MED') || l.includes('AMBER') || (util ?? 0) >= 0.6) return tokens.congestion.AMBER;
  return tokens.congestion.GREEN;
};

/** POST /api/cargo/yard-planning — allocate a planned yard position. */
function YardPlanForm({ onDone, containers, yardBlocks }: { onDone: () => void; containers: string[]; yardBlocks: string[] }) {
  const { adapter } = useApp();
  const [containerNo, setContainerNo] = useState('');
  const [yardBlock, setYardBlock] = useState('');
  const [slot, setSlot] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FormMsg | null>(null);

  const submit = async () => {
    if (!adapter.createYardPlan) { setMsg({ kind: 'danger', text: 'The yard-planning API is unavailable in this data mode.' }); return; }
    if (!containerNo.trim()) { setMsg({ kind: 'danger', text: 'Enter a container number.' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await adapter.createYardPlan({
        container_number: containerNo.trim().toUpperCase().replace(/\s+/g, ''),
        // Deployed POC-3 yard-planning contract requires `preferred_block` (not
        // `yard_block`). Payload key aligned to the backend; this affects the
        // yard-planning request ONLY.
        ...(yardBlock.trim() ? { preferred_block: yardBlock.trim() } : {}),
        ...(slot.trim() ? { slot: slot.trim() } : {}),
      });
      setMsg({
        kind: 'success',
        title: 'Yard planning completed successfully.',
        details: [
          { label: 'Container', value: r.container_number ?? containerNo },
          { label: 'Block', value: r.yard_block ?? yardBlock },
          { label: 'Slot', value: r.slot ?? slot },
        ],
      });
      setContainerNo(''); setYardBlock(''); setSlot('');
      cargoRefreshStore.bump();
      onDone();
    } catch (e) {
      setMsg({ kind: 'danger', text: cargoErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: '10px 12px', background: tokens.color.bgElevated }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* Container dropdown — existing containers loaded from the backend (no hardcoding). */}
        <Picker label="Container" value={containerNo} options={containers} placeholder="container" onChange={setContainerNo} />
        {/* Yard block dropdown — dynamically derived blocks (adapter reduces to the zone letter on POST). */}
        <Picker label="Yard block" value={yardBlock} options={yardBlocks} placeholder="yard block" minWidth={120} onChange={setYardBlock} />
        {/* Position / Slot — OPTIONAL; persisted only via this form's createYardPlan payload. */}
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 120 }}>Position / Slot (optional)
          <CalciteInput scale="s" value={slot} placeholder="R3-07" onCalciteInputInput={(e) => setSlot((e.target as unknown as { value: string }).value)} />
        </CalciteLabel>
      </div>
      {msg && msg.kind === 'danger' && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 8 }}>
          <div slot="message">{msg.text}</div>
        </CalciteNotice>
      )}
      {msg && msg.kind === 'success' && (
        <SuccessNotice title={msg.title} details={msg.details} style={{ marginTop: 8 }} />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <CalciteButton scale="s" iconStart="pin" loading={busy} disabled={busy} onClick={submit}>Allocate yard position</CalciteButton>
      </div>
    </div>
  );
}

/** POST /api/cargo/reefer-planning — allocate a reefer slot with temp/power. */
function ReeferPlanForm({ onDone, containers }: { onDone: () => void; containers: string[] }) {
  const { adapter } = useApp();
  const [containerNo, setContainerNo] = useState('');
  const [temp, setTemp] = useState('');
  const [power, setPower] = useState('');
  const [slot, setSlot] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FormMsg | null>(null);

  const submit = async () => {
    if (!adapter.createReeferPlan) { setMsg({ kind: 'danger', text: 'The reefer-planning API is unavailable in this data mode.' }); return; }
    if (!containerNo.trim()) { setMsg({ kind: 'danger', text: 'Enter a container number.' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await adapter.createReeferPlan({
        container_number: containerNo.trim().toUpperCase().replace(/\s+/g, ''),
        ...(temp.trim() !== '' && Number.isFinite(Number(temp)) ? { temperature_c: Number(temp) } : {}),
        ...(power.trim() !== '' && Number.isFinite(Number(power)) ? { power_kw: Number(power) } : {}),
        ...(slot.trim() ? { slot: slot.trim() } : {}),
      });
      setMsg({
        kind: 'success',
        title: 'Reefer planning completed successfully.',
        details: [
          { label: 'Container', value: r.container_number ?? containerNo },
          { label: 'Slot', value: r.slot ?? slot },
        ],
      });
      setContainerNo(''); setTemp(''); setPower(''); setSlot('');
      cargoRefreshStore.bump();
      onDone();
    } catch (e) {
      setMsg({ kind: 'danger', text: cargoErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: '10px 12px', background: tokens.color.bgElevated }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* Container dropdown — existing containers loaded from the backend (no hardcoding). */}
        <Picker label="Container" value={containerNo} options={containers} placeholder="container" onChange={setContainerNo} />
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 100 }}>Temp (°C)
          <CalciteInput scale="s" type="number" value={temp} placeholder="-18" onCalciteInputInput={(e) => setTemp((e.target as unknown as { value: string }).value)} />
        </CalciteLabel>
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 100 }}>Power (kW)
          <CalciteInput scale="s" type="number" value={power} placeholder="7.5" onCalciteInputInput={(e) => setPower((e.target as unknown as { value: string }).value)} />
        </CalciteLabel>
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 100 }}>Slot
          <CalciteInput scale="s" value={slot} placeholder="RP-04" onCalciteInputInput={(e) => setSlot((e.target as unknown as { value: string }).value)} />
        </CalciteLabel>
      </div>
      {msg && msg.kind === 'danger' && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 8 }}>
          <div slot="message">{msg.text}</div>
        </CalciteNotice>
      )}
      {msg && msg.kind === 'success' && (
        <SuccessNotice title={msg.title} details={msg.details} style={{ marginTop: 8 }} />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <CalciteButton scale="s" iconStart="temperature" loading={busy} disabled={busy} onClick={submit}>Allocate reefer slot</CalciteButton>
      </div>
    </div>
  );
}

/**
 * Yard Assignment (UC-II Pendency flow) — assigns a yard block to an existing
 * container by REUSING the existing cargo write `adapter.updateCargo(cn, { yard_block })`
 * (PUT /api/cargo/{id}); the exact same API/behaviour the Vessel Discharge modal
 * already uses. Additive only — no new API, no change to the discharge modal. This
 * places Yard Assignment inside Pendency (before Yard Planning) per the UC-II flow.
 */
function YardAssignForm({ onDone, containers, yardBlocks }: { onDone: () => void; containers: string[]; yardBlocks: string[] }) {
  const { adapter } = useApp();
  const [containerNo, setContainerNo] = useState('');
  const [yardBlock, setYardBlock] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FormMsg | null>(null);

  const submit = async () => {
    if (!adapter.updateCargo) { setMsg({ kind: 'danger', text: 'The cargo update API is unavailable in this data mode.' }); return; }
    if (!containerNo.trim()) { setMsg({ kind: 'danger', text: 'Select a container.' }); return; }
    if (!yardBlock.trim()) { setMsg({ kind: 'danger', text: 'Select a yard block.' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      // Existing Poc3CargoAdapter write — PUT /api/cargo/{id} { yard_block } → POC-3.
      await adapter.updateCargo(containerNo, { yard_block: yardBlock });
      setMsg({
        kind: 'success',
        title: 'Yard assigned successfully.',
        details: [
          { label: 'Container', value: containerNo },
          { label: 'Assigned Yard', value: yardBlock },
        ],
      });
      setContainerNo(''); setYardBlock('');
      cargoRefreshStore.bump(); // Movement + Pendency + Yard Planning options refetch
      onDone();
    } catch (e) {
      setMsg({ kind: 'danger', text: cargoErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: '10px 12px', background: tokens.color.bgElevated }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Picker label="Container" value={containerNo} options={containers} placeholder="container" onChange={setContainerNo} />
        <Picker label="Yard block" value={yardBlock} options={yardBlocks} placeholder="yard block" minWidth={120} onChange={setYardBlock} />
      </div>
      {msg && msg.kind === 'danger' && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 8 }}>
          <div slot="message">{msg.text}</div>
        </CalciteNotice>
      )}
      {msg && msg.kind === 'success' && (
        <SuccessNotice title={msg.title} details={msg.details} style={{ marginTop: 8 }} />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <CalciteButton scale="s" iconStart="pin-tear" loading={busy} disabled={busy} onClick={submit}>Assign yard block</CalciteButton>
      </div>
    </div>
  );
}

export function YardBackendPlanning() {
  const { adapter } = useApp();
  const cargoRev = useCargoRefresh();
  const available = Boolean(adapter.getYardOptimization || adapter.createYardPlan || adapter.createReeferPlan);
  const [reload, setReload] = useState(0);

  const opt = useAsync<YardOptimization>(
    () => (adapter.getYardOptimization ? adapter.getYardOptimization() : Promise.resolve({})),
    [adapter, cargoRev, reload],
  );

  // Existing cargo list from the existing backend (reused adapter method, unchanged
  // API) → drives the container + yard-block dropdowns. Refetches on any cargo write.
  const cargo = useAsync<ContainerMovementDTO[]>(
    () => adapter.getContainerMovements({}),
    [adapter, cargoRev, reload],
  );

  if (!available) return null;

  const o = opt.data ?? {};
  const congestion = o.congestion ?? [];
  const priority = o.priority_containers ?? [];
  const moves = o.suggested_moves ?? [];

  // Dropdown option lists — derived dynamically, never hardcoded.
  const rows = cargo.data ?? [];
  const containerOptions = Array.from(new Set(rows.map((m) => m.container.containerNo))).sort();
  // Yard blocks come from live cargo assignments AND the optimization congestion
  // snapshot, unioned so the picker offers every block the backend actually knows.
  const yardBlockOptions = Array.from(
    new Set([
      ...rows.map((m) => m.cargo?.yard_block).filter((y): y is string => !!y),
      ...congestion.map((c) => c.yard_block).filter((y): y is string => !!y),
    ]),
  ).sort();

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>Yard Planning &amp; Optimization</strong>
        <CalciteChip scale="s" value="poc3" kind="brand">POC-3 · live</CalciteChip>
      </div>

      {/* GET /api/cargo/yard-optimization */}
      <div style={sectionHead}>Optimization snapshot</div>
      {opt.loading ? (
        <CalciteLoader scale="s" label="Loading optimization" />
      ) : opt.error ? (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="message">{opt.error}</div>
        </CalciteNotice>
      ) : congestion.length === 0 && priority.length === 0 && moves.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '2px 0' }}>No optimization data returned.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {congestion.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: tokens.color.text, marginBottom: 4 }}>Congestion</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {congestion.map((c, i) => (
                  <CalciteChip key={c.yard_block ?? i} scale="s" value={c.yard_block ?? String(i)} style={{ ['--calcite-chip-text-color' as never]: congestionColor(c.level, c.utilization) }}>
                    {(c.yard_block ?? 'block')}{c.utilization != null ? ` · ${Math.round(c.utilization * 100)}%` : ''}{c.level ? ` · ${c.level}` : ''}
                  </CalciteChip>
                ))}
              </div>
            </div>
          )}
          {priority.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: tokens.color.text, marginBottom: 4 }}>Priority containers</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {priority.map((p, i) => (
                  <CalciteChip key={p.container_number ?? i} scale="s" value={p.container_number ?? String(i)} title={p.reason ?? undefined}>
                    {p.container_number ?? '—'}{p.reason ? ` · ${p.reason}` : ''}
                  </CalciteChip>
                ))}
              </div>
            </div>
          )}
          {moves.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: tokens.color.text, marginBottom: 4 }}>Suggested moves</div>
              <CalciteTable caption="suggested moves" scale="s">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Container" />
                  <CalciteTableHeader heading="From" />
                  <CalciteTableHeader heading="To" />
                  <CalciteTableHeader heading="Reason" />
                </CalciteTableRow>
                {moves.slice(0, 25).map((m, i) => (
                  <CalciteTableRow key={m.container_number ?? i}>
                    <CalciteTableCell>{m.container_number ?? '—'}</CalciteTableCell>
                    <CalciteTableCell>{m.from ?? '—'}</CalciteTableCell>
                    <CalciteTableCell>{m.to ?? '—'}</CalciteTableCell>
                    <CalciteTableCell>{m.reason ?? '—'}</CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}
        </div>
      )}

      {/* Yard Assignment (existing PUT /api/cargo/{id} { yard_block }) — UC-II flow:
          assign the yard from the Pendency flow, before planning. */}
      <div style={sectionHead}>Yard assignment</div>
      <YardAssignForm onDone={() => setReload((r) => r + 1)} containers={containerOptions} yardBlocks={yardBlockOptions} />

      {/* POST /api/cargo/yard-planning */}
      <div style={sectionHead}>Allocate yard position</div>
      <YardPlanForm onDone={() => setReload((r) => r + 1)} containers={containerOptions} yardBlocks={yardBlockOptions} />

      {/* POST /api/cargo/reefer-planning */}
      <div style={sectionHead}>Reefer slot allocation</div>
      <ReeferPlanForm onDone={() => setReload((r) => r + 1)} containers={containerOptions} />
    </div>
  );
}
