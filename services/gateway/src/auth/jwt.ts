/**
 * Dependency-free HS256 JWT issue/verify for the PoC dev issuer (prompt §14
 * OAuth2/OIDC + JWT). Production verifies RS256 against the OIDC issuer's JWKS;
 * the verify interface is identical so the swap is config-only. Uses Node's
 * built-in crypto — no third-party JWT library.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@jnpa/schemas';

export interface JwtClaims {
  sub: string;
  /** RBAC role claim (prompt §9) — enforced at the gateway. */
  role: Role;
  /** Facility ids the subject is scoped to (row-level). */
  facilities?: string[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function issueToken(
  claims: Omit<JwtClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
  opts: { secret: string; issuer: string; audience: string; ttlSec?: number; nowSec: number },
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtClaims = {
    ...claims,
    iss: opts.issuer,
    aud: opts.audience,
    iat: opts.nowSec,
    exp: opts.nowSec + (opts.ttlSec ?? 3600),
  };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', opts.secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export interface VerifyResult {
  valid: boolean;
  claims?: JwtClaims;
  error?: string;
}

export function verifyToken(
  token: string,
  opts: { secret: string; audience: string; nowSec: number },
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed token' };
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', opts.secret).update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, error: 'bad signature' };
  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return { valid: false, error: 'bad payload' };
  }
  if (claims.aud !== opts.audience) return { valid: false, error: 'aud mismatch' };
  if (claims.exp < opts.nowSec) return { valid: false, error: 'expired' };
  return { valid: true, claims };
}
