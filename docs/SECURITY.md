# Security & Compliance — JNPA UC2

> Maps the §14 bar (UC1 parity + bid §7.3/§7.4) to where it is enforced in code.

## AuthN / AuthZ (§14, §9)
- **OAuth2/OIDC + JWT.** The gateway verifies a bearer JWT on every `/api/*`
  ([`auth/jwt.ts`](../services/gateway/src/auth/jwt.ts)). PoC mints HS256 dev
  tokens via `POST /auth/dev-token`; production verifies RS256 against the OIDC
  issuer JWKS (`OIDC_ISSUER`) — same `verifyToken` interface, config-only swap.
- **Claim-based RBAC** (§9). The `role` claim is enforced at the gateway:
  scenario runs are restricted to port-wide roles; the audit endpoint is
  `DTCCC_ADMIN`-only. **Row-level scoping** filters facility-scoped roles
  ([`rbac-scope.ts`](../packages/data/src/rbac-scope.ts)) — e.g. `CFS_OPERATOR`
  sees only CFS facilities. Enforced both at the gateway and in the adapter so
  mock and live behave identically. Covered by `gateway.test` + poc-selftest D4.

## OWASP API Top-10 posture (§14)
- Security headers on every response (`nosniff`, `DENY` frame, HSTS, CSP)
  ([`middleware.ts`](../services/gateway/src/middleware.ts)).
- **Per-consumer rate limiting** (token bucket) — `429` after burst. Covered by
  `gateway.test`.
- Input validation at the boundary via the canonical **JSON-Schema** registry
  (`@jnpa/schemas` AJV) — connectors/gateway reject malformed payloads.
- No secrets in code; only `.env` (+ committed `.env.example`). Connectors
  **refuse to fake live data** without credentials (`SourceUnavailable`).

## Transport
- **TLS 1.3** terminated at the ingress/Enterprise reverse proxy in production
  (out of scope for the offline PoC container which serves plain HTTP on the
  internal network). Documented as the deployment posture.

## Audit logging (§14)
- Every authenticated gateway request is recorded (actor, role, action,
  resource, outcome) ([`middleware.ts` `AuditLog`](../services/gateway/src/middleware.ts))
  and surfaced at `GET /api/audit` (admin-only). **180-day retention posture**:
  `AUDIT_RETENTION_DAYS=180`; the DDL `silver.audit_log` table is the persistent
  sink in production.

## DPDP purpose-limitation (§1, §14)
- The medallion pipeline enforces purpose-limitation at the **Silver→Gold**
  boundary: `gold.kpi_snapshot` carries **no PII columns** (no `vehicle_no`,
  no driver identity) — only aggregate KPI values keyed by facility
  ([`ddl/001_canonical.sql`](../packages/schemas/src/ddl/001_canonical.sql)).
  `DPDP_PURPOSE_LIMITATION=true` gates the projection. Raw PII stays in
  Bronze/Silver behind RBAC.

## Data residency / IPR (handover)
- Raw native payloads (EDI/X12/ICES/JSON) are preserved by `rawRef` in the object
  store (`bronze.raw_message`) so source artifacts are handed to JNPA per the
  IPR/handover clause (prompt §4).

## Accessibility & resilience (§14)
- Calcite dark theme; **graceful empty/error states** (never blank — `Panel`
  renders Calcite notices/loaders). Keyboard focus + reduced-motion via Calcite.
- **No colour literals outside `tokens.ts`** — single source for all hues incl.
  severity + traffic-lights.
- Tablet-responsive shell layout.

## Live-credential onboarding (no faked live data)
- See [README](../README.md#live-data-onboarding-keltronjnpa-only). Each
  connector documents the exact onboarding step (ULIP NDA, ICEGATE DSC/IEC, CRIS)
  and stays on the schema-accurate simulator until credentials are present.
