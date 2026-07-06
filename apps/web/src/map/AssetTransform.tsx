/**
 * AssetTransform — a compact overlay panel for changing the POSITION and
 * DIRECTION of a movable 3D asset (vessel / crane / gate / yard block / truck
 * route / rail rake / tug). Shown on the 3D scene in Edit mode once an asset is
 * selected in the tree.
 *
 * Every control tick edits the placementStore SYNCHRONOUSLY (that IS the export
 * data — it lands in positions.json immediately) and calls `onChange(pkey)` so
 * the scene rebuilds ONLY that asset's layer — you see the move/rotate on the map
 * the instant you make it. The panel subscribes to the store so its read-out and
 * slider track live as you drag.
 *
 * Controls:
 *   • heading slider + ±15° buttons  → rotate the asset (0–360°)
 *   • N / S / E / W arrows           → nudge the asset by the chosen step
 *   • step selector (1 / 5 / 25 m)   → nudge granularity
 *   • live lng / lat / heading read-out
 *   • "Reset this asset" → revert just this asset to its seeded position
 */
import {
  CalciteButton, CalciteSlider, CalciteSegmentedControl, CalciteSegmentedControlItem, CalciteIcon,
} from '@esri/calcite-components-react';
import { useState, useSyncExternalStore } from 'react';
import { placementStore } from './placementStore.js';
import { pkeyPosition, pkeyHeading } from './scene3d.js';
import type { Terminal } from '@jnpa/schemas';
import { tokens } from '../theme/tokens.js';

interface Props {
  /** Placement key of the selected asset (null → panel hidden). */
  pkey: string | null;
  /** Human label for the header. */
  label?: string | null;
  terminals: Terminal[];
  /** Called after each move/rotate with the affected pkey → rebuild that asset. */
  onChange: (pkey: string) => void;
  /** Whether route-draw mode is active for THIS asset (truckroute:* only). */
  drawing?: boolean;
  /** Toggle route-draw mode on/off for this route. */
  onToggleDraw?: () => void;
  /** Called after Undo/Clear edits the route path → refresh preview + trucks. */
  onRouteEdited?: () => void;
}

const STEPS = [1, 5, 25] as const;

export function AssetTransform({ pkey, label, terminals, onChange, drawing, onToggleDraw, onRouteEdited }: Props) {
  const [step, setStep] = useState<number>(5);
  // Subscribe to the placement store so the read-out + slider reflect every
  // change the instant it lands (including live slider drags + drawn waypoints).
  useSyncExternalStore(
    (cb) => placementStore.subscribe(cb),
    () => (pkey ? JSON.stringify(placementStore.get(pkey) ?? null) : ''),
  );
  if (!pkey) return null;
  const pos = pkeyPosition(pkey, terminals);
  if (!pos) return null;
  const heading = Math.round(pkeyHeading(pkey));
  const isRoute = pkey.startsWith('truckroute:');
  const wpCount = placementStore.getPath(pkey)?.length ?? 0;

  // apply: write to the store (→ export data, synchronously) THEN rebuild just
  // this asset on the map — no full-scene rebuild, so the change shows instantly.
  const apply = (fn: () => void) => {
    fn();
    onChange(pkey);
  };
  const nudge = (dir: 'N' | 'S' | 'E' | 'W') => apply(() => placementStore.nudge(pkey, dir, step, pos));
  const setHeading = (h: number) => apply(() => placementStore.setHeading(pkey, h, pos));

  const btn = { width: 34, height: 34 } as const;

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 232,
        background: tokens.color.bgPanel,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: 8,
        padding: 12,
        boxShadow: '0 2px 10px rgba(0,0,0,.14)',
        zIndex: 6,
        fontSize: 12,
        color: tokens.color.text,
      }}
      role="group"
      aria-label="Asset position and direction controls"
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Move &amp; rotate</div>
      <div style={{ color: tokens.color.textMuted, marginBottom: 10 }}>{label ?? pkey}</div>

      {/* Route drawing (truck routes only): trace the road on the imagery so the
          trucks follow the real path instead of the synthetic loop. */}
      {isRoute && (
        <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${tokens.color.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span>Road route</span>
            <span style={{ color: tokens.color.textMuted }}>{wpCount} pts</span>
          </div>
          <CalciteButton
            width="full"
            scale="s"
            appearance={drawing ? 'solid' : 'outline'}
            kind={drawing ? 'brand' : 'neutral'}
            iconStart={drawing ? 'check' : 'pencil'}
            onClick={onToggleDraw}
          >
            {drawing ? 'Click roads to add points — Done' : wpCount ? 'Edit road route' : 'Draw road route'}
          </CalciteButton>
          {drawing && (
            <div style={{ fontSize: 11, color: tokens.color.textMuted, margin: '6px 0' }}>
              Click along the road in order; the loop closes back to the first point.
            </div>
          )}
          {wpCount > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <CalciteButton scale="s" appearance="outline" iconStart="undo" onClick={() => { placementStore.undoWaypoint(pkey); onRouteEdited?.(); }}>Undo pt</CalciteButton>
              <CalciteButton scale="s" appearance="outline" kind="danger" iconStart="trash" onClick={() => { placementStore.clearPath(pkey); onRouteEdited?.(); }}>Clear</CalciteButton>
            </div>
          )}
        </div>
      )}

      {/* Direction / heading */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Direction</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{heading}°</span>
      </div>
      <CalciteSlider
        min={0}
        max={359}
        step={1}
        value={heading}
        onCalciteSliderInput={(e) => setHeading((e.target as unknown as { value: number }).value)}
        style={{ marginBlock: 4 }}
      />
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <CalciteButton scale="s" appearance="outline" iconStart="rotate-anticlockwise" onClick={() => setHeading(heading - 15)}>−15°</CalciteButton>
        <CalciteButton scale="s" appearance="outline" iconEnd="rotate-clockwise" onClick={() => setHeading(heading + 15)}>+15°</CalciteButton>
      </div>

      {/* Position — a small N/S/E/W D-pad */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span>Position</span>
        <CalciteSegmentedControl
          scale="s"
          width="auto"
          onCalciteSegmentedControlChange={(e) => setStep(Number((e.target as unknown as { value: string }).value))}
        >
          {STEPS.map((s) => (
            <CalciteSegmentedControlItem key={s} value={String(s)} checked={s === step}>{s} m</CalciteSegmentedControlItem>
          ))}
        </CalciteSegmentedControl>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, justifyItems: 'center', marginBottom: 10 }}>
        <span />
        <CalciteButton scale="s" appearance="outline" style={btn} onClick={() => nudge('N')} title="Move north"><CalciteIcon icon="chevron-up" scale="s" /></CalciteButton>
        <span />
        <CalciteButton scale="s" appearance="outline" style={btn} onClick={() => nudge('W')} title="Move west"><CalciteIcon icon="chevron-left" scale="s" /></CalciteButton>
        <div style={{ display: 'flex', alignItems: 'center', color: tokens.color.textMuted, fontSize: 10 }}>N/S/E/W</div>
        <CalciteButton scale="s" appearance="outline" style={btn} onClick={() => nudge('E')} title="Move east"><CalciteIcon icon="chevron-right" scale="s" /></CalciteButton>
        <span />
        <CalciteButton scale="s" appearance="outline" style={btn} onClick={() => nudge('S')} title="Move south"><CalciteIcon icon="chevron-down" scale="s" /></CalciteButton>
        <span />
      </div>

      {/* Read-out */}
      <div style={{ fontVariantNumeric: 'tabular-nums', color: tokens.color.textMuted, fontSize: 11, marginBottom: 10 }}>
        {pos[1].toFixed(5)}, {pos[0].toFixed(5)}
      </div>

      <CalciteButton
        scale="s"
        appearance="outline"
        kind="danger"
        width="full"
        iconStart="reset"
        onClick={() => apply(() => placementStore.resetKey(pkey))}
      >
        Reset this asset
      </CalciteButton>
    </div>
  );
}
