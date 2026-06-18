/**
 * Deterministic PRNG for the simulators (prompt §12, Addendum B.2: "every
 * generator takes a seed; the same runbook + seed produces an identical run").
 *
 * Uses splitmix64-style mixing over a 32-bit state (mulberry32) — fast, no
 * dependency, and reproducible across platforms. NEVER use Math.random in the
 * sim path; a non-deterministic demo is a failed demo.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid a zero state.
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /** True with probability p. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Pick one element of a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[this.int(0, arr.length - 1)]!;
  }

  /** Pick `k` distinct elements (Fisher–Yates partial shuffle). */
  sample<T>(arr: readonly T[], k: number): T[] {
    const copy = [...arr];
    const n = Math.min(k, copy.length);
    for (let i = 0; i < n; i++) {
      const j = this.int(i, copy.length - 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, n);
  }

  /** Gaussian-ish value via central-limit (sum of 3 uniforms), mean/stddev. */
  gaussian(mean: number, stddev: number): number {
    const u = (this.next() + this.next() + this.next()) / 3; // ~N(0.5, ...)
    return mean + (u - 0.5) * 2 * Math.sqrt(3) * stddev;
  }

  /** Fork a child RNG deterministically derived from the parent + label. */
  fork(label: string): Rng {
    let h = this.state;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    }
    return new Rng(h >>> 0);
  }
}

/** Deterministic ULID-ish id from an RNG (sortable-ish, demo-stable). */
export function simId(rng: Rng, prefix: string): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[rng.int(0, chars.length - 1)];
  return `${prefix}-${s}`;
}
