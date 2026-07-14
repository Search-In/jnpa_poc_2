/**
 * RakePlanning — the POC-3 Rail Rake Planning integration (Jayesh handover),
 * rendered as an additive section inside the existing Rail (T1/T2) tab. Backs
 * UC-II requirement 5 ("obtain data from CTO and FOIS … to provide visibility of
 * rakes to Terminal operators for yard planning"):
 *
 *   GET  /api/cargo/rake-planning → existing rake plans
 *   POST /api/cargo/rake-planning → create a rake plan
 *
 * POC-3 owns the rake-planning logic; this is a thin consumer. Purely additive —
 * the existing rake/wagon tables and next-24h forecast above are untouched.
 * Hides itself when the Cargo API is not the active data source (mock/sim).
 */
import { useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteInput, CalciteLabel, CalciteLoader, CalciteNotice,
  CalciteOption, CalciteSelect,
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
} from '@esri/calcite-components-react';
import type { SidingId } from '@jnpa/schemas';
import type { ContainerMovementDTO, RakePlan } from '@jnpa/data';
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

const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function RakePlanning({ siding, rakeIds }: { siding: SidingId; rakeIds?: string[] }) {
  const { adapter } = useApp();
  const cargoRev = useCargoRefresh();
  const available = Boolean(adapter.getRakePlans || adapter.createRakePlan);
  const [reload, setReload] = useState(0);

  const plans = useAsync<RakePlan[]>(
    () => (adapter.getRakePlans ? adapter.getRakePlans() : Promise.resolve([])),
    [adapter, cargoRev, reload],
  );
  // Existing live containers for the container dropdown — reused adapter method,
  // unchanged API. Only fetched when the section is active.
  const cargo = useAsync<ContainerMovementDTO[]>(
    () => (available ? adapter.getContainerMovements({}) : Promise.resolve([])),
    [adapter, cargoRev, reload],
  );

  // Composer state.
  const [rakeId, setRakeId] = useState('');
  const [containerPick, setContainerPick] = useState('');
  const [selectedContainers, setSelectedContainers] = useState<string[]>([]);
  const [placement, setPlacement] = useState('');
  const [departure, setDeparture] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<FormMsg | null>(null);

  // Dropdown options — derived dynamically, never hardcoded.
  const containerOptions = Array.from(new Set((cargo.data ?? []).map((m) => m.container.containerNo))).sort();
  // Rake IDs: real rail rakes (backend, via prop) ∪ existing rake-plan rake_ids
  // (GET /api/cargo/rake-planning). Empty → a disabled "No rake available" option.
  const rakeOptions = Array.from(new Set([
    ...(rakeIds ?? []),
    ...(plans.data ?? []).map((p) => p.rake_id).filter((x): x is string => !!x),
  ])).sort();

  const addContainer = () => {
    const c = containerPick.trim();
    if (!c) return;
    setSelectedContainers((list) => (list.includes(c) ? list : [...list, c]));
    setContainerPick('');
  };
  const removeContainer = (c: string) => setSelectedContainers((list) => list.filter((x) => x !== c));

  if (!available) return null;

  const submit = async () => {
    if (!adapter.createRakePlan) { setMsg({ kind: 'danger', text: 'The rake-planning API is unavailable in this data mode.' }); return; }
    if (!rakeId.trim()) { setMsg({ kind: 'danger', text: 'Select a rake.' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await adapter.createRakePlan({
        rake_id: rakeId.trim(),
        siding,
        ...(selectedContainers.length ? { container_numbers: selectedContainers } : {}),
        ...(placement ? { planned_placement: new Date(placement).toISOString() } : {}),
        ...(departure ? { planned_departure: new Date(departure).toISOString() } : {}),
      });
      setMsg({
        kind: 'success',
        title: 'Rake plan created successfully.',
        details: [{ label: 'Rake', value: r.rake_id ?? rakeId }],
      });
      setRakeId(''); setSelectedContainers([]); setContainerPick(''); setPlacement(''); setDeparture('');
      cargoRefreshStore.bump();
      setReload((n) => n + 1);
    } catch (e) {
      setMsg({ kind: 'danger', text: cargoErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>Rake Planning</strong>
        <CalciteChip scale="s" value="poc3" kind="brand">POC-3 · live</CalciteChip>
      </div>

      {/* GET /api/cargo/rake-planning */}
      <div style={sectionHead}>Rake plans</div>
      {plans.loading ? (
        <CalciteLoader scale="s" label="Loading rake plans" />
      ) : plans.error ? (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="message">{plans.error}</div>
        </CalciteNotice>
      ) : (plans.data?.length ?? 0) === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '2px 0' }}>No rake plans yet.</p>
      ) : (
        <CalciteTable caption="rake plans" scale="s">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Rake" />
            <CalciteTableHeader heading="Siding" />
            <CalciteTableHeader heading="Containers" />
            <CalciteTableHeader heading="Placement" />
            <CalciteTableHeader heading="Departure" />
            <CalciteTableHeader heading="Status" />
          </CalciteTableRow>
          {plans.data!.slice(0, 25).map((p, i) => (
            <CalciteTableRow key={p.id ?? p.rake_id ?? i}>
              <CalciteTableCell>{p.rake_id ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{p.siding ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{Array.isArray(p.container_numbers) ? p.container_numbers.length : '—'}</CalciteTableCell>
              <CalciteTableCell>{fmt(p.planned_placement)}</CalciteTableCell>
              <CalciteTableCell>{fmt(p.planned_departure)}</CalciteTableCell>
              <CalciteTableCell>{p.status ?? '—'}</CalciteTableCell>
            </CalciteTableRow>
          ))}
        </CalciteTable>
      )}

      {/* POST /api/cargo/rake-planning */}
      <div style={sectionHead}>Create rake plan · {siding}</div>
      <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: '10px 12px', background: tokens.color.bgElevated }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Rake id — dropdown of existing rake IDs (rail rakes ∪ existing plans). */}
          <CalciteLabel scale="s" style={{ flex: 1, minWidth: 160 }}>Rake id
            <CalciteSelect
              label="Rake id"
              scale="s"
              disabled={rakeOptions.length === 0}
              onCalciteSelectChange={(e) => setRakeId((e.target as unknown as { value: string }).value)}
            >
              <CalciteOption value="" selected={rakeId === ''}>
                {rakeOptions.length === 0 ? 'No rake available' : 'Select rake…'}
              </CalciteOption>
              {rakeOptions.map((r) => (
                <CalciteOption key={r} value={r} selected={r === rakeId}>{r}</CalciteOption>
              ))}
            </CalciteSelect>
          </CalciteLabel>
          {/* Containers — dropdown of existing live containers; Add builds the list. */}
          <CalciteLabel scale="s" style={{ flex: 2, minWidth: 220 }}>Containers
            <div style={{ display: 'flex', gap: 6 }}>
              <CalciteSelect
                label="Container"
                scale="s"
                disabled={containerOptions.filter((c) => !selectedContainers.includes(c)).length === 0}
                onCalciteSelectChange={(e) => setContainerPick((e.target as unknown as { value: string }).value)}
              >
                <CalciteOption value="" selected={containerPick === ''}>
                  {containerOptions.length === 0 ? 'No containers available' : 'Select container…'}
                </CalciteOption>
                {containerOptions.filter((c) => !selectedContainers.includes(c)).map((c) => (
                  <CalciteOption key={c} value={c} selected={c === containerPick}>{c}</CalciteOption>
                ))}
              </CalciteSelect>
              <CalciteButton scale="s" appearance="outline" iconStart="plus" disabled={!containerPick} onClick={addContainer}>Add</CalciteButton>
            </div>
          </CalciteLabel>
        </div>
        {selectedContainers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {selectedContainers.map((c) => (
              <CalciteChip key={c} scale="s" value={c} closable onCalciteChipClose={() => removeContainer(c)}>{c}</CalciteChip>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <CalciteLabel scale="s" style={{ flex: 1, minWidth: 180 }}>Planned placement
            <CalciteInput scale="s" type="datetime-local" value={placement} onCalciteInputInput={(e) => setPlacement((e.target as unknown as { value: string }).value)} />
          </CalciteLabel>
          <CalciteLabel scale="s" style={{ flex: 1, minWidth: 180 }}>Planned departure
            <CalciteInput scale="s" type="datetime-local" value={departure} onCalciteInputInput={(e) => setDeparture((e.target as unknown as { value: string }).value)} />
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
          <CalciteButton scale="s" iconStart="train" loading={busy} disabled={busy} onClick={submit}>Create rake plan</CalciteButton>
        </div>
      </div>
    </div>
  );
}
