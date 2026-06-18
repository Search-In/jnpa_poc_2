/**
 * Panel — a Calcite block wrapper that renders loading / error / empty states
 * uniformly (prompt §14: never blank). Every dashboard panel composes this.
 */
import React from 'react';
import { CalciteBlock, CalciteNotice, CalciteLoader } from '@esri/calcite-components-react';
import type { AsyncState } from '../state/useAsync.js';

interface PanelProps<T> {
  heading: string;
  description?: string;
  state: AsyncState<T>;
  /** Considered empty when this returns true. */
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
  open?: boolean;
}

export function Panel<T>({ heading, description, state, isEmpty, children, open = true }: PanelProps<T>) {
  return (
    <CalciteBlock heading={heading} description={description} open={open} collapsible>
      {state.loading && <CalciteLoader label="Loading" text="Loading…" />}
      {state.error && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle">
          <div slot="title">Could not load</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      )}
      {!state.loading && !state.error && state.data != null && (
        isEmpty && isEmpty(state.data) ? (
          <CalciteNotice open kind="info" icon="information">
            <div slot="title">No data</div>
            <div slot="message">Nothing to show for the current filter.</div>
          </CalciteNotice>
        ) : (
          <>{children(state.data)}</>
        )
      )}
    </CalciteBlock>
  );
}
