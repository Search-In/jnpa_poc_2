/**
 * Event bus abstraction. In mock/offline mode this is a synchronous in-process
 * pub/sub (zero network — Addendum B.2 "offline-first"); the gateway swaps in a
 * Kafka-backed implementation in live mode behind the same interface. The demo
 * console and the simulators publish through this exactly as connectors do.
 */
import type { CloudEvent, TopicName } from './cloudevents.js';

export type Subscriber = (event: CloudEvent) => void;

export interface EventBus {
  publish(topic: TopicName, event: CloudEvent): void;
  subscribe(topic: TopicName, fn: Subscriber): () => void;
  /** Count of events published per topic (for the demo console event counter). */
  counts(): Record<string, number>;
  reset(): void;
}

/** Synchronous, deterministic, in-memory bus for mock mode. */
export class InMemoryEventBus implements EventBus {
  private subs = new Map<string, Set<Subscriber>>();
  private published: Record<string, number> = {};

  publish(topic: TopicName, event: CloudEvent): void {
    this.published[topic] = (this.published[topic] ?? 0) + 1;
    const set = this.subs.get(topic);
    if (set) {
      for (const fn of set) fn(event);
    }
  }

  subscribe(topic: TopicName, fn: Subscriber): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  counts(): Record<string, number> {
    return { ...this.published };
  }

  reset(): void {
    this.subs.clear();
    this.published = {};
  }
}
