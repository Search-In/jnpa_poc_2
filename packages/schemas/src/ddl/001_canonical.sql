-- ============================================================================
-- JNPA UC2 — Canonical relational + spatial schema (prompt §1 data, §3 model)
-- PostgreSQL + PostGIS. Medallion pipeline: bronze (raw) -> silver (canonical)
-- -> gold (KPI marts). DPDP purpose-limitation enforced at silver->gold.
-- TimescaleDB hypertable on the events table for time-series history (§1).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
-- TimescaleDB optional in PoC; guarded so DDL runs without it.
-- CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS bronze;  -- raw EDI/X12/ICES/JSON as ingested
CREATE SCHEMA IF NOT EXISTS silver;  -- normalised canonical entities
CREATE SCHEMA IF NOT EXISTS gold;    -- KPI-ready marts (purpose-limited)

-- ---------------------------------------------------------------------------
-- Enumerated types (mirror packages/schemas TS unions exactly)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE silver.origin_stream AS ENUM
    ('IMPORT_CFS','IMPORT_ICD','IMPORT_DPD','EXPORT_CFS','EXPORT_ICD','EXPORT_DPE','TRANSSHIP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE silver.source_system AS ENUM
    ('ULIP','ICEGATE','TOS','FOIS','ESEAL','SHIPLINE','SIM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE silver.container_status AS ENUM
    ('EXPECTED','GATE_IN','IN_YARD','RAIL_IN','RAIL_OUT','UNDER_SCAN','HELD_CUSTOMS',
     'STUFFING','DESTUFFING','ITRHO_IN_TRANSIT','GATE_OUT','DEPARTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE silver.event_type AS ENUM
    ('GATE_IN','GATE_OUT','RAIL_IN','RAIL_OUT','YARD_MOVE','SCAN_START','SCAN_END','LEO',
     'STUFFING','DESTUFFING','ITRHO_OUT','ITRHO_IN','DAMAGE_FLAG','CUSTOMS_FLAG',
     'ESEAL_AFFIX','ESEAL_BREAK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE silver.facility_type AS ENUM
    ('TERMINAL','CFS','ICD','DPE','DPD','ECD','CPP','RAIL_SIDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- BRONZE — raw payload landing (audit / IPR handover clause §4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bronze.raw_message (
  raw_ref         TEXT PRIMARY KEY,                 -- object-store key
  source_system   silver.source_system NOT NULL,
  native_format   TEXT NOT NULL,                    -- CODECO|COARRI|X12-322|CHSAI|ULIP-JSON|...
  received_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  byte_size       INTEGER,
  sha256          TEXT,
  raw_body        TEXT                              -- inline copy for PoC; prod = object store only
);

-- ---------------------------------------------------------------------------
-- SILVER — canonical entities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS silver.facility (
  facility_id      TEXT PRIMARY KEY,
  type             silver.facility_type NOT NULL,
  name             TEXT NOT NULL,
  operator         TEXT NOT NULL,
  geom             geometry(Geometry, 4326) NOT NULL,
  capacity_teu     INTEGER,
  current_pendency INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS facility_geom_gix ON silver.facility USING GIST (geom);
CREATE INDEX IF NOT EXISTS facility_type_ix ON silver.facility (type);

CREATE TABLE IF NOT EXISTS silver.terminal (
  terminal_id   TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  operator      TEXT NOT NULL,
  status        TEXT NOT NULL,
  geom          geometry(Geometry, 4326) NOT NULL,
  quay_length_m INTEGER,
  capacity_teu  INTEGER,
  gates         TEXT[] NOT NULL DEFAULT '{}',
  sidings       TEXT[] NOT NULL DEFAULT '{}',
  tos_mode      TEXT NOT NULL,
  tos_url       TEXT,
  tos_drop_dir  TEXT,
  edi_version   TEXT
);

CREATE TABLE IF NOT EXISTS silver.container (
  container_no    TEXT PRIMARY KEY,                 -- ISO 6346
  iso_type_code   TEXT NOT NULL,
  size_ft         SMALLINT NOT NULL CHECK (size_ft IN (20,40,45)),
  laden           BOOLEAN NOT NULL,
  gross_wt_kg     NUMERIC(12,2) NOT NULL,
  cargo_type      TEXT NOT NULL,
  hazmat_imdg     JSONB,
  reefer          JSONB,
  line_owner      TEXT NOT NULL,
  current_seal_no TEXT NOT NULL DEFAULT '',
  status          silver.container_status NOT NULL,
  origin_stream   silver.origin_stream NOT NULL,
  last_updated_ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS container_origin_ix ON silver.container (origin_stream);
CREATE INDEX IF NOT EXISTS container_status_ix ON silver.container (status);

-- Event-sourced spine. Candidate TimescaleDB hypertable on (ts).
CREATE TABLE IF NOT EXISTS silver.cargo_event (
  event_id          TEXT NOT NULL,
  container_no      TEXT NOT NULL,
  event_type        silver.event_type NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,
  source_offset_min INTEGER NOT NULL,
  facility_id       TEXT NOT NULL REFERENCES silver.facility(facility_id),
  terminal_id       TEXT,
  gate_id           TEXT,
  vehicle_no        TEXT,
  rake_id           TEXT,
  source_system     silver.source_system NOT NULL,
  raw_ref           TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (event_id, ts)                        -- composite for hypertable partitioning
);
CREATE INDEX IF NOT EXISTS cargo_event_container_ix ON silver.cargo_event (container_no, ts);
CREATE INDEX IF NOT EXISTS cargo_event_type_ix ON silver.cargo_event (event_type, ts);
CREATE INDEX IF NOT EXISTS cargo_event_facility_ix ON silver.cargo_event (facility_id, ts);
-- SELECT create_hypertable('silver.cargo_event','ts', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS silver.gate_transaction (
  gate_txn_id    TEXT PRIMARY KEY,
  gate_id        TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  vehicle_no     TEXT NOT NULL,
  container_no   TEXT,
  appointment_ref TEXT,
  arrival_ts     TIMESTAMPTZ NOT NULL,
  start_ts       TIMESTAMPTZ NOT NULL,
  end_ts         TIMESTAMPTZ,
  docs_verified  TEXT[] NOT NULL DEFAULT '{}',
  outcome        TEXT NOT NULL CHECK (outcome IN ('CLEARED','HELD','REJECTED'))
);
CREATE INDEX IF NOT EXISTS gate_txn_gate_ix ON silver.gate_transaction (gate_id, arrival_ts);

CREATE TABLE IF NOT EXISTS silver.rake (
  rake_id      TEXT PRIMARY KEY,
  cto_operator TEXT NOT NULL,
  train_no     TEXT NOT NULL,
  fois_ref     TEXT NOT NULL,
  siding_id    TEXT NOT NULL CHECK (siding_id IN ('T1','T2')),
  terminal_id  TEXT NOT NULL,
  arrival_ts   TIMESTAMPTZ NOT NULL,
  placement_ts TIMESTAMPTZ,
  removal_ts   TIMESTAMPTZ,
  departure_ts TIMESTAMPTZ,
  wagon_count  INTEGER NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  mixed_flag   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS rake_siding_ix ON silver.rake (siding_id, arrival_ts);

CREATE TABLE IF NOT EXISTS silver.wagon (
  wagon_id      TEXT PRIMARY KEY,
  rake_id       TEXT NOT NULL REFERENCES silver.rake(rake_id),
  position      INTEGER NOT NULL,
  container_nos TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS silver.itrho_movement (
  itrho_id        TEXT PRIMARY KEY,
  container_no     TEXT NOT NULL,
  from_terminal_id TEXT NOT NULL,
  to_terminal_id   TEXT NOT NULL,
  requested_ts     TIMESTAMPTZ NOT NULL,
  out_ts           TIMESTAMPTZ,
  in_ts            TIMESTAMPTZ,
  mode             TEXT NOT NULL CHECK (mode IN ('RAIL','ROAD'))
);

CREATE TABLE IF NOT EXISTS silver.scan_event (
  scan_id      TEXT PRIMARY KEY,
  container_no TEXT NOT NULL,
  scanner_id   TEXT NOT NULL,
  flagged_by   TEXT NOT NULL CHECK (flagged_by IN ('CUSTOMS','RANDOM')),
  start_ts     TIMESTAMPTZ NOT NULL,
  end_ts       TIMESTAMPTZ,
  result       TEXT CHECK (result IN ('CLEAR','HOLD','EXAM'))
);

CREATE TABLE IF NOT EXISTS silver.shipping_doc (
  doc_id        TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('IAL','EAL','DO','BE','SB','FORM13')),
  container_nos TEXT[] NOT NULL DEFAULT '{}',
  line_id       TEXT NOT NULL,
  issued_ts     TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS silver.empty_pool (
  line_id              TEXT NOT NULL,
  depot_id             TEXT NOT NULL,
  available_qty        INTEGER NOT NULL,
  projected_demand_qty INTEGER NOT NULL,
  as_of_ts             TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (line_id, depot_id, as_of_ts)
);

CREATE TABLE IF NOT EXISTS silver.notification (
  notif_id      TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('INFO','WARN','CRIT')),
  audience_roles TEXT[] NOT NULL DEFAULT '{}',
  facility_id   TEXT,
  container_no  TEXT,
  body_en       TEXT NOT NULL,
  body_hi       TEXT NOT NULL,
  body_mr       TEXT NOT NULL,
  created_ts    TIMESTAMPTZ NOT NULL,
  ack_by        TEXT,
  ack_ts        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notif_created_ix ON silver.notification (created_ts DESC);

CREATE TABLE IF NOT EXISTS silver.integration_health (
  source_system    silver.source_system PRIMARY KEY,
  last_good_poll_ts TIMESTAMPTZ,
  error_count      INTEGER NOT NULL DEFAULT 0,
  degradation      TEXT NOT NULL CHECK (degradation IN ('GREEN','AMBER','RED')),
  mode             TEXT NOT NULL CHECK (mode IN ('LIVE','CACHED','SYNTHETIC')),
  note             TEXT
);

-- ---------------------------------------------------------------------------
-- GOLD — KPI marts (purpose-limited; no PII columns crossing this boundary)
-- Materialised by services/kpi. Definitions live in docs/KPI_DEFINITIONS.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gold.kpi_snapshot (
  kpi_key       TEXT NOT NULL,
  facility_id   TEXT,                 -- null = port-wide rollup
  snapshot_ts   TIMESTAMPTZ NOT NULL,
  value         NUMERIC NOT NULL,
  unit          TEXT NOT NULL,
  baseline      NUMERIC,
  improvement_pct NUMERIC,
  PRIMARY KEY (kpi_key, COALESCE(facility_id,''), snapshot_ts)
);

-- Audit log (180-day retention posture §14).
CREATE TABLE IF NOT EXISTS silver.audit_log (
  audit_id    BIGSERIAL PRIMARY KEY,
  actor       TEXT,
  role        TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS audit_ts_ix ON silver.audit_log (ts DESC);
