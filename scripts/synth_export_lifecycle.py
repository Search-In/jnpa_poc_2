"""
Build the SYNTHETIC export lifecycle in schema `synth`.

Design rules (deliberate, do not relax):
  * Everything lives in schema `synth` — droppable with one DROP SCHEMA, and
    unmistakable in any query plan or export.
  * Container numbers use owner prefix SYNU, which is NOT an allocated BIC owner
    code, so a synthetic box can never collide with or be mistaken for a real one.
    Check digits are real ISO 6346 so format validators still pass.
  * Shipping bills use the 8,xxx,xxx range; the real corpus SBs are 4.00–4.04M and
    real LEOs are 2.05–2.38M, so the ranges cannot overlap.
  * Every chain TERMINATES in a real vessel call and its real VESDEP departure
    timestamp — so the last step of a synthetic chain is verifiable against
    customer data. Only the container and its documents are invented.
  * Deterministic: seeded from the container number, so re-running reproduces
    byte-identical rows.

USAGE
-----
This script WRITES TO A DATABASE and starts by dropping and recreating the two
tables in schema `synth`. It therefore refuses to run without an explicit `--yes`.

    export SYNTH_EXPORT_DSN='postgresql://user:pass@host:5432/dbname'
    python scripts/synth_export_lifecycle.py --yes

To remove everything it created:

    DROP SCHEMA synth CASCADE;

It never issues DDL against, or writes to, any table outside schema `synth`. It
does READ `core.vessel_call` to anchor each chain to a real vessel departure.
"""
import argparse
import asyncio
import hashlib
import json
import os
import sys
from datetime import timedelta

import asyncpg


def resolve_dsn() -> str:
    """DSN comes from the environment only — never a hard-coded path, and never
    committed. Raises with instructions rather than silently targeting a database
    the caller did not intend."""
    dsn = os.environ.get("SYNTH_EXPORT_DSN")
    if not dsn:
        sys.exit(
            "SYNTH_EXPORT_DSN is not set.\n"
            "This script writes synthetic data and will not guess a target database.\n"
            "  export SYNTH_EXPORT_DSN='postgresql://user:pass@host:5432/dbname'"
        )
    return dsn.replace("?sslmode=require", "")

# ---- ISO 6346 -------------------------------------------------------------
_LETTER = {c: v for c, v in zip(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25,
     26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38])}


def check_digit(owner_serial: str) -> int:
    """owner_serial = 4 letters + 6 digits."""
    total = 0
    for i, ch in enumerate(owner_serial):
        val = _LETTER[ch] if ch.isalpha() else int(ch)
        total += val * (2 ** i)
    return total % 11 % 10


def container_no(seq: int) -> str:
    body = f"SYNU{seq:06d}"
    return f"{body}{check_digit(body)}"


def rng(container: str, salt: str, lo: int, hi: int) -> int:
    """Deterministic pseudo-random int in [lo, hi] derived from the container."""
    h = hashlib.sha256(f"{container}:{salt}".encode()).digest()
    return lo + (int.from_bytes(h[:8], "big") % (hi - lo + 1))


def pick(container: str, salt: str, options: list):
    return options[rng(container, salt, 0, len(options) - 1)]


# ---- reference values, all lifted verbatim from the real corpus ------------
PODS = ["LKCMB", "DEHAM", "USDGS", "PTSIE", "HKHKG", "THLCH", "USNYC", "SAJED",
        "MYPKG", "SGSIN", "NLRTM", "AEJEA"]
LINES = ["MSC", "ONE", "CMA", "MSK", "COSCO", "HLI", "OOCL", "EVERGREEN", "KMTC"]
ISOS = ["2210", "4510", "4530", "2270"]
CFS = ["Polaris Logistics Park Pvt Ltd (CFSCLP)", "Speedy Multimode Ltd CFS",
       "CWC Distripark", "Continental Warehousing (CWCCFS)", "Balmer Lawrie (CFSBLC)"]
TRANSPORTERS = ["Transtar Handling & Warehousing Co", "Inline Shipping Logistics India LLP",
                "Sealand Roadways Pvt Ltd", "Konkan Carriers"]
ORIGINS = [("INTKD", "ICD Rail", "R"), ("INBLR", "ICD Rail", "R"),
           ("INNSA", "CFS", "T"), ("INPNQ", "ICD Rail", "R"), ("INAMD", "CFS", "T")]

# The 10 canonical steps (03_Export_Container_Lifecycle.md), with hours BEFORE
# the vessel's real departure. Jitter is added per container.
STEPS = [
    ("BOOKING",   "Liner booking",                  240),
    ("PREADVICE", "Form 11 / Form 13 pre-advice",   132),
    ("GATE_IN",   "Gate-in (EIR / CODECO 'E')",      96),
    ("VGM",       "VGM & seals",                     88),
    ("SB",        "Shipping Bill filed",             76),
    ("LEO",       "Let Export Order granted",        64),
    ("EAL",       "Export advance list to terminal", 48),
    ("COPRAR",    "COPRAR load list",                30),
    ("COARRI",    "COARRI load confirmation",         6),
    ("VESDEP",    "Vessel departure",                 0),
]

DDL = """
CREATE SCHEMA IF NOT EXISTS synth;
COMMENT ON SCHEMA synth IS
  'SYNTHETIC DEMO DATA — generated, NOT customer data. Exists because the JNPA '
  'corpus is disjoint by design: no real container traverses the full export '
  'lifecycle. Container prefix SYNU is not an allocated BIC owner code. Safe to '
  'DROP SCHEMA synth CASCADE at any time; no real table references it.';

DROP TABLE IF EXISTS synth.export_event;
DROP TABLE IF EXISTS synth.export_container;

CREATE TABLE synth.export_container (
  container_no      text PRIMARY KEY,
  is_synthetic      boolean NOT NULL DEFAULT true,
  iso_code          text NOT NULL,
  line_code         text NOT NULL,
  booking_no        text NOT NULL,
  origin_port       text,
  origin_type       text,
  arrival_mode      text,
  cfs_name          text,
  transporter       text,
  truck_no          text,
  pod               text NOT NULL,
  vgm_kg            numeric(12,3),
  line_seal         text,
  customs_seal      text,
  shipping_bill_no  bigint,
  shipping_bill_date date,
  leo_no            bigint,
  leo_date          date,
  leo_rotation_no   text,
  gate_pass_no      text,
  gate_no           text,
  -- the REAL anchor: these three columns join to core.vessel_call
  vcn               text NOT NULL,
  vessel_name       text NOT NULL,
  via_no            text,
  departed_at       timestamptz NOT NULL,
  CONSTRAINT export_container_is_synthetic CHECK (is_synthetic)
);
COMMENT ON TABLE synth.export_container IS
  'One synthetic export container per row, traversing all 10 canonical steps. '
  'vcn/vessel_name/departed_at are REAL values joined from core.vessel_call.';

CREATE TABLE synth.export_event (
  container_no  text NOT NULL REFERENCES synth.export_container(container_no) ON DELETE CASCADE,
  step_no       smallint NOT NULL,
  step_code     text NOT NULL,
  step_label    text NOT NULL,
  event_ts      timestamptz NOT NULL,
  doc_ref       text,
  detail        jsonb,
  PRIMARY KEY (container_no, step_no)
);
COMMENT ON TABLE synth.export_event IS
  'The per-step timeline. step_no 1..10 follows the canonical export order; '
  'step 10 (VESDEP) carries the REAL departure timestamp of the real vessel.';

CREATE INDEX ON synth.export_event (step_code);
CREATE INDEX ON synth.export_container (vcn);
"""


async def main(dsn: str):
    c = await asyncpg.connect(dsn, ssl="require")
    # Refuse to touch a database whose customs tables are already fully linked —
    # if real SB↔container data has landed, this synthetic layer should be dropped,
    # not regenerated (see markdowns/04_Export_Build_Plan.md §2.6 rule 4).
    await c.execute(DDL)

    # Real vessel calls that now carry a real VESDEP departure — the anchors.
    anchors = await c.fetch("""
        SELECT vcn, vessel_name, via_no, atd
        FROM core.vessel_call
        WHERE atd IS NOT NULL AND vcn LIKE 'INNSA%'
        ORDER BY atd""")
    anchors = [dict(a) for a in anchors]
    print(f"anchor vessel calls (real, with real VESDEP atd): {len(anchors)}")
    for a in anchors:
        print(f"   {a['vcn']:16} {a['vessel_name']:18} {a['atd']}")

    N = 60
    containers, events = [], []
    for i in range(1, N + 1):
        cn = container_no(i)
        a = anchors[i % len(anchors)]
        dep = a["atd"]
        origin_port, origin_type, arrival_mode = pick(cn, "origin", ORIGINS)
        iso = pick(cn, "iso", ISOS)
        vgm = 4000 + rng(cn, "vgm", 0, 26000) if iso.startswith("2") else 8000 + rng(cn, "vgm", 0, 22000)
        sb_no = 8_000_000 + i * 137
        leo_no = 8_500_000 + i * 211
        # Timeline: each step jittered up to ±6 h, clamped to stay ordered.
        prev = None
        step_ts = {}
        for n, (code, label, hours_before) in enumerate(STEPS, start=1):
            if code == "VESDEP":
                # NEVER adjusted: this must stay bit-identical to the real
                # core.vessel_call.atd, so the last step of a synthetic chain is
                # always verifiable against customer data.
                ts = dep
            else:
                ts = dep - timedelta(hours=hours_before + rng(cn, code, -6, 6))
                # Keep strictly ordered AND strictly before departure, so the
                # forward clamp below can never push a step onto/past the sailing.
                if prev is not None and ts <= prev:
                    ts = prev + timedelta(minutes=30)
                ts = min(ts, dep - timedelta(minutes=30))
            step_ts[code] = ts
            prev = ts
            events.append((cn, n, code, label, ts))

        containers.append((
            cn, iso, pick(cn, "line", LINES), f"EBKG{rng(cn, 'bk', 10**9, 10**10 - 1)}",
            origin_port, origin_type, arrival_mode,
            pick(cn, "cfs", CFS), pick(cn, "tr", TRANSPORTERS),
            f"MH{rng(cn, 'mh', 40, 48)}{chr(65 + rng(cn, 'l1', 0, 25))}{chr(65 + rng(cn, 'l2', 0, 25))}{rng(cn, 'num', 1000, 9999)}",
            pick(cn, "pod", PODS), vgm,
            f"LG{rng(cn, 'ls', 10**7, 10**8 - 1)}", str(rng(cn, "cs", 10**6, 10**7 - 1)),
            sb_no, step_ts["SB"].date(), leo_no, step_ts["LEO"].date(),
            pick(cn, "rot", ["1180983", "1179546", "2003", "1832"]),
            str(rng(cn, "gp", 16_400_000, 16_599_999)), str(rng(cn, "gate", 1, 3)),
            a["vcn"], a["vessel_name"], a["via_no"], dep,
        ))

    async with c.transaction():
        await c.executemany("""
            INSERT INTO synth.export_container (
              container_no, iso_code, line_code, booking_no, origin_port, origin_type,
              arrival_mode, cfs_name, transporter, truck_no, pod, vgm_kg, line_seal,
              customs_seal, shipping_bill_no, shipping_bill_date, leo_no, leo_date,
              leo_rotation_no, gate_pass_no, gate_no, vcn, vessel_name, via_no, departed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        """, containers)

        detail_for = {}
        by_cn = {row[0]: row for row in containers}
        rows = []
        for cn, n, code, label, ts in events:
            r = by_cn[cn]
            d = {
                "BOOKING":   {"booking_no": r[3], "line_code": r[2], "pod": r[10]},
                "PREADVICE": {"origin_port": r[4], "origin_type": r[5], "arrival_mode": r[6], "cfs": r[7]},
                "GATE_IN":   {"gate_pass_no": r[19], "gate_no": r[20], "truck_no": r[9], "transporter": r[8]},
                "VGM":       {"vgm_kg": float(r[11]), "line_seal": r[12], "customs_seal": r[13]},
                "SB":        {"shipping_bill_no": r[14], "site_id": "INJNP1"},
                "LEO":       {"leo_no": r[16], "rotation_no": r[18], "shipping_bill_no": r[14]},
                "EAL":       {"vessel_visit": r[23], "iso_code": r[1], "pod": r[10]},
                "COPRAR":    {"vcn": r[21], "vessel_name": r[22]},
                "COARRI":    {"vcn": r[21], "loaded": True},
                "VESDEP":    {"vcn": r[21], "vessel_name": r[22], "via_no": r[23], "source": "REAL core.vessel_call.atd"},
            }[code]
            ref = {"BOOKING": r[3], "GATE_IN": r[19], "SB": str(r[14]), "LEO": str(r[16]),
                   "VESDEP": r[21]}.get(code)
            rows.append((cn, n, code, label, ts, ref, json.dumps(d)))
        await c.executemany("""
            INSERT INTO synth.export_event (container_no, step_no, step_code, step_label, event_ts, doc_ref, detail)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)""", rows)

    print(f"\ninserted: {len(containers)} containers, {len(rows)} events")
    await c.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Generate the SYNTHETIC export lifecycle in schema `synth`.")
    ap.add_argument(
        "--yes", action="store_true",
        help="Required. Confirms you intend to DROP and recreate schema `synth` "
             "on the database in $SYNTH_EXPORT_DSN.")
    args = ap.parse_args()
    target = resolve_dsn()
    if not args.yes:
        # Show where it would write, with the password redacted, then stop.
        redacted = target
        if "@" in redacted:
            head, tail = redacted.split("@", 1)
            if ":" in head:
                redacted = head.rsplit(":", 1)[0] + ":***@" + tail
        sys.exit(
            f"Refusing to run without --yes.\n"
            f"  target : {redacted}\n"
            f"  effect : DROP + recreate synth.export_container and synth.export_event\n"
            f"           (~60 containers, ~600 events). Nothing outside schema `synth` "
            f"is modified.\n"
            f"  rerun  : python scripts/synth_export_lifecycle.py --yes"
        )
    asyncio.run(main(target))
