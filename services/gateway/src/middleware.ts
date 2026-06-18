/**
 * Gateway middleware (prompt §14): per-consumer rate limiting, audit logging
 * (180-day retention posture), and security headers (OWASP API Top-10 posture).
 * Pure/in-memory for the PoC; production swaps Redis-backed limiter + persistent
 * audit sink without changing the call sites.
 */
import type { ServerResponse } from 'node:http';

// ---- rate limiter (token bucket per consumer) -----------------------------
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private capacity = 100,
    private refillPerSec = 20,
    private clock: () => number = Date.now,
  ) {}

  allow(consumer: string): boolean {
    const now = this.clock();
    let b = this.buckets.get(consumer);
    if (!b) {
      b = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(consumer, b);
    }
    const elapsed = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }
}

// ---- audit log ------------------------------------------------------------
export interface AuditEntry {
  ts: string;
  actor?: string;
  role?: string;
  action: string;
  resource?: string;
  outcome: 'OK' | 'DENIED' | 'ERROR';
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private clock: () => string = () => new Date().toISOString()) {}
  record(e: Omit<AuditEntry, 'ts'>): void {
    this.entries.push({ ...e, ts: this.clock() });
  }
  recent(n = 100): AuditEntry[] {
    return this.entries.slice(-n);
  }
  get size(): number {
    return this.entries.length;
  }
}

// ---- security headers (OWASP posture) -------------------------------------
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
  res.setHeader('content-security-policy', "default-src 'self'");
}
