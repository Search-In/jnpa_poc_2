/**
 * Panel — a Calcite block wrapper that renders loading / error / empty states
 * uniformly (prompt §14: never blank). Every dashboard panel composes this.
 *
 * ⚠ The empty state is mode-aware, and that is not cosmetic.
 *
 * In LIVE the shared backend filters every register to rows whose
 * `data_origin = 'API'` — i.e. rows that arrived through the JNPA Simulated
 * Port-Data API rather than the corpus import. Most UC-II document registers
 * currently hold ZERO such rows (the API's records for customs, gate documents
 * and shipping-line documents failed to route into their consumers), so LIVE
 * empties them. Reporting that as a bland "no data for the current filter"
 * reads as a broken panel and hides a real integration gap. The panel names the
 * cause instead, and offers the way back.
 */
import React, { useSyncExternalStore } from 'react';
import { CalciteBlock, CalciteNotice, CalciteLoader, CalciteButton } from '@esri/calcite-components-react';
import type { AsyncState } from '../state/useAsync.js';
import {
  getDataSourceMode, setDataSourceMode, subscribeDataSourceMode,
} from '../state/dataSourceMode.js';

interface PanelProps<T> {
  heading: string;
  description?: string;
  state: AsyncState<T>;
  /** Considered empty when this returns true. */
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
  /**
   * Panel chrome rendered in EVERY state — loading, error, empty and populated.
   *
   * For the Import/Export toolbar. It used to live inside `children`, which the
   * empty branch replaces wholesale, so a panel with no rows offered no way to
   * import any: the one moment the button matters is the one moment it vanished.
   * A toolbar belongs to the panel, not to its data.
   */
  toolbar?: React.ReactNode;
  open?: boolean;
}

/** The empty notice, worded for whichever provenance filter is active. */
function EmptyNotice() {
  const mode = useSyncExternalStore(subscribeDataSourceMode, getDataSourceMode, getDataSourceMode);

  if (mode !== 'LIVE') {
    return (
      <CalciteNotice open kind="info" icon="information">
        <div slot="title">No data</div>
        <div slot="message">Nothing to show for the current filter.</div>
      </CalciteNotice>
    );
  }

  return (
    <CalciteNotice open kind="warning" icon="exclamation-mark-triangle">
      <div slot="title">Empty because the data source is LIVE</div>
      <div slot="message">
        <p style={{ margin: '0 0 6px' }}>
          LIVE restricts every register to rows that arrived through the JNPA Port-Data API.
          This register holds none: the API delivered records for it, but they did not route into
          the backing tables, so there is nothing API-sourced to show. The pre-loaded corpus rows
          are still there — DEMO shows them.
        </p>
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart="database"
          onClick={() => {
            setDataSourceMode('DEMO');
            // Matches DataSourceToggle: no query cache here, so reload to refetch
            // every panel with the new X-Data-Mode header.
            window.location.reload();
          }}
        >
          Switch to DEMO (pre-loaded)
        </CalciteButton>
      </div>
    </CalciteNotice>
  );
}

export function Panel<T>({
  heading, description, state, isEmpty, children, toolbar, open = true,
}: PanelProps<T>) {
  return (
    <CalciteBlock heading={heading} description={description} open={open} collapsible>
      {toolbar}
      {state.loading && <CalciteLoader label="Loading" text="Loading…" />}
      {state.error && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle">
          <div slot="title">Could not load</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      )}
      {!state.loading && !state.error && state.data != null && (
        isEmpty && isEmpty(state.data) ? <EmptyNotice /> : <>{children(state.data)}</>
      )}
    </CalciteBlock>
  );
}
