# UC-II Web App Integration — What to Send, What You Get Back

**Jawaharlal Nehru Port Authority · Digital Twin PoC · Tender GeM/2026/B/7297343**
Workstream 2 — UC-II Improved Cargo Handling & Logistics Optimization

**This is the document to build the frontend from.**

You POST rows shaped exactly like `Cargo_Training_Input_Sample.xlsx`. The
service does the translation. **The web app does no mapping, no lookup tables,
no date parsing and no unit conversion.**

Companion documents:
[UC2_MODELS_GUIDE.md](UC2_MODELS_GUIDE.md) explains what each model *means*;
[UC2_INTEGRATION.md](UC2_INTEGRATION.md) is the low-level native-contract spec.
This one is the only one you need to wire up a screen.

---

## 0. The two surfaces, and which one to use

The service exposes every model twice.

| | Native surface | **Web-app surface** |
|---|---|---|
| Path | `/uc2/m1/predict-one` | **`/uc2/webapp/m1/dwell`** |
| You send | `{"stream_idx":0,"line_idx":1,...}` | **the JNPA row, verbatim** |
| Who maps `"CTO-2"` → `1` | you | **the service** |
| Who parses `"2026-06-07 08:27"` | you | **the service** |
| Who knows `"T2"` is siding index 1 | you | **the service** |
| Use it when | you already hold model-native floats | **always, from the web app** |

**Use `/uc2/webapp/*`.** The native endpoints are unchanged and still work;
they exist for systems that already speak the model contract.

Start the service:

```bash
pip install -r requirements.txt
python run.py serve-uc2          # http://127.0.0.1:8200
```

Interactive docs with a try-it form for every endpoint below:
**http://127.0.0.1:8200/docs**

---

## 1. The contract in one paragraph

Send a row. Get back the model's answer **plus a `mapping` block that shows
every model input, where it came from, and whether it was measured or assumed.**
If the adapter had to assume anything, `degraded` is `true` and
`mapping.assumptions[]` names it in plain English. Nothing is ever silently
substituted, and an unrecognised code is never quietly mapped to index 0.

```jsonc
{
  "p50Hours": 88.02,                    // the model's answer
  "degraded": true,                     // ← badge this
  "decision_path": "engine=... | adapter=adapter-v1.0.0 | assumed=1",
  "mapping": {
    "inputs_observed": 5,
    "inputs_assumed": 1,
    "derived": [                        // ← the "why" drawer
      { "model_input": "facility_load", "value": 0.74,
        "source": "Terminal_Yard_Utilization_Pct", "raw": "74",
        "rule": "percent / 100", "observed": true }
    ],
    "assumptions": [
      "arrival_cadence_h=6.0 -- no arrival cadence and no daily volume column; 6.0 h is the corpus mean inter-arrival gap"
    ],
    "warnings": []
  }
}
```

---

## 2. Every endpoint, at a glance

| Sheet you hold | POST to | You get |
|---|---|---|
| `J1` / `J2` / `J6` row | `/uc2/webapp/m1/dwell` | Dwell hours + departure clock time |
| **many `J1` rows** | **`/uc2/webapp/m1/dwell-batch`** | **same, with *measured* arrival cadence** |
| `J7` row | `/uc2/webapp/m2/rake` | Rake TAT + placement/removal times |
| `J3` / `J4` row | `/uc2/webapp/m3/queue` | Next-hour gate queue + defer flag |
| `J4` row | `/uc2/webapp/m3/queue-curve?hours=12` | Multi-hour queue curve + defer windows |
| `J9` row | `/uc2/webapp/m4/event` | Anomaly findings from the row's flags |
| lifecycle rows for one box | `/uc2/webapp/m4/trail` | M4's real R1–R6 lifecycle rules |
| `J10` row | `/uc2/webapp/m5/vessel` | Projected berth stay |
| `J3`+`J4`+`J10` rows | `/uc2/webapp/m6/lanes` | Lane plan + unservable traffic |
| `J8`+`J10` rows | `/uc2/webapp/m7/reefer` | Reefer plug allocation + exposure |
| `J8` rows | `/uc2/webapp/m7/empties` | Empty pool balance + reposition plan |
| — | `GET /uc2/webapp/mappings` | **every code table — build your dropdowns from this** |

---

## 3. M1 — Container Dwell

### Send: one J1 / J2 / J6 row

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m1/dwell \
  -H 'Content-Type: application/json' \
  -d '{
    "Container_No": "DPWU9011100",
    "Terminal_Code": "NSICT",
    "Shipping_Line_Code": "CHZ",
    "Delivery_Mode": "G",
    "Container_Status": "FCL",
    "Customs_Status": "PENDING",
    "Selected_Scan": "No",
    "Nature_Of_Cargo": "GENERAL",
    "Terminal_Yard_Utilization_Pct": 74,
    "Arrival_DateTime": "2026-06-07 08:27",
    "IGM_No": "1194313"
  }'
```

### Columns the model actually reads

| Column | Becomes | How | Needed? |
|---|---|---|---|
| `Delivery_Mode`, `DPD_Eligible`, `Origin_ICD`, `Container_Status`, `Pre_Advice_Type` | `stream_idx` | Empty box → `EMPTY_RETURN`; ICD → ICD stream; DPD → DPD; else CFS | **yes** |
| `Shipping_Line_Code` — or `Container_No` | `line_idx` | PCS code table; falls back to the ISO 6346 owner prefix; unknown → `OTHER` | **yes** |
| `Customs_Status`, `Selected_Scan` | `customs_flag` | `HELD`/`UNDER_INSPECTION`/… → 1. **`PENDING` is *not* a hold** | **yes** |
| `Is_Reefer`, `Nature_Of_Cargo`, `Goods_Description` | `reefer` | explicit flag first, then cargo text | **yes** |
| `Terminal_Yard_Utilization_Pct` or `Facility_Load` | `facility_load` | percent ÷ 100 | **yes** |
| `Arrival_DateTime` | `gate_in_utc` | parsed → real departure clock time | optional |
| `Arrival_Cadence_H` | `arrival_cadence_h` | see the batch note below | optional |

> **Send the batch endpoint, not this one in a loop.**
> `arrival_cadence_h` means *hours since the previous container arrived at this
> facility*. **No single row can carry it.** A batch can: `/m1/dwell-batch`
> sorts each terminal's rows by `Arrival_DateTime` and measures the gaps.
> One row at a time → the 6.0 h default and `degraded: true` on every response.
>
> ```bash
> curl -X POST http://127.0.0.1:8200/uc2/webapp/m1/dwell-batch \
>   -H 'Content-Type: application/json' -d '[ {...}, {...}, {...} ]'
> ```
>
> The batch response adds `cadence.measured_rows` / `cadence.assumed_rows`.
> The first box at each terminal has no predecessor, so it stays assumed —
> widen the time window to measure more of them.

### Get back

| Field | Meaning |
|---|---|
| `dwellHours` / `p50Hours` | **The answer: hours the box will sit.** |
| `p10Hours` / `p90Hours` | Optimistic / pessimistic. **Always render the band.** |
| `predictedDepartureUtc` | Real clock time — only if you sent `Arrival_DateTime` |
| `predictedDepartureWindowUtc` | `[earliest, latest]` as timestamps |
| `confidenceBandHours` | `p90 − p10`. Badge when wide. |
| `breakdown.terms[]` | `{factor, hours}` — the "why this number?" drawer |
| `container`, `terminal` | Echoed back for the row you sent |

**Real output from the shipped sample:**

| Container | Terminal | p50 | Band | Stream / Line |
|---|---|---|---|---|
| DPWU9011100 | NSICT | **88.0 h** | 82.3 – 94.2 | IMPORT_CFS / OTHER |
| CSNU1399404 | NSICT | **84.8 h** | 79.1 – 91.0 | IMPORT_CFS / CMA_CGM |
| DFSU1691030 | GTI | **88.3 h** | 82.6 – 94.5 | IMPORT_CFS / OTHER |
| NYKU4768188 | GTI | **85.7 h** | 80.0 – 91.9 | IMPORT_CFS / ONE |

All four are `degraded: true` for one reason only: the sample carries two
arrival timestamps at two different terminals, so no cadence gap exists to
measure. Send a wider window and the badge clears.

---

## 4. M2 — Rake Turnaround Time

### Send: one J7 row

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m2/rake \
  -H 'Content-Type: application/json' \
  -d '{
    "Rake_ID": "RK-AGM-0654", "Siding": "T2", "CTO_Index": "CTO-2",
    "Terminal_Code": "NSICT", "Direction": "Inbound",
    "Wagon_Count": 45, "Container_Count": 90, "TEU": 180,
    "Arrival_Hour": 14, "Arrival_Timestamp": "2026-06-11 14:00",
    "Destination_Terminal": "NSICT"
  }'
```

### The three translations that matter

These are the ones a hand-written frontend gets wrong:

| Column | Value in sheet | Model wants | Note |
|---|---|---|---|
| `Siding` | `"T1"` / `"T2"` | `0` / `1` | text, not an index |
| `CTO_Index` | `"CTO-1"` / `"CTO-2"` | `0` / `1` | **the sheet is 1-based, the model is 0-based** |
| `Direction` | `"Inbound"` | `1` | `Outbound` → `0` |

| Other column | Becomes | Note |
|---|---|---|
| `Wagon_Count` | `wagon_count` | direct |
| `Container_Count` | `container_count` | **send it.** Falls back to `TEU ÷ 2`, then to the corpus 1.15 boxes/wagon — and the real JNPA rakes run **2.1** boxes/wagon, so guessing from wagons halves the handling term |
| `Destination_Terminal` | `terminal_count` | distinct count; more destinations = more shunting |
| `Arrival_Hour` / `Arrival_Timestamp` | `arrival_hour` | night and morning peak add congestion |

### Get back

| Field | Meaning |
|---|---|
| `tatHours` | **Total hours the rake occupies the siding** |
| `etaPlacementH` / `etaPlacementUtc` | When handling can start (25 % of TAT) |
| `etaRemovalH` / `etaRemovalUtc` | When handling finishes (80 % of TAT) |
| `departureWindowUtc` | `[earliest, latest]` departure |
| `breakdown.steps[]` | **placement / handling / congestion / release, arithmetic substituted** |

**Real output from the shipped sample:**

| Rake | Siding | CTO | Wagons | Boxes | TAT | Placement | Removal |
|---|---|---|---|---|---|---|---|
| RK-SRE-0711 | T1 | CONCOR | 42 | 90 | **6.32 h** | 15 Jun 07:55 | 15 Jun 11:23 |
| RK-AGM-0654 | T2 | GATEWAY | 45 | 90 | **6.93 h** | 11 Jun 15:44 | 11 Jun 19:33 |
| RK-BMC-0651 | T2 | GATEWAY | 40 | 82 | **6.79 h** | 10 Jun 00:27 | 10 Jun 04:11 |

All three `degraded: false` — J7 carries every input.

> **Render this caveat.** The corpus records no observed rake placement,
> removal or departure, so these coefficients are **auditable operating
> assumptions, not outcomes validated against reality.**

---

## 5. M3 — Gate Queue

### Send: one J4 bucket (best) or one J3 transaction

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m3/queue \
  -H 'Content-Type: application/json' \
  -d '{
    "Gate_ID": "NSIGT-G1", "Terminal_Code": "NSIGT",
    "Timestamp": "2026-06-10 12:15", "Hour_Of_Day": 12,
    "Queue_Lag1": 19, "Queue_Lag2": 17,
    "UC3_Truck_Inflow_Per_Hr": 38, "Lanes_Open": 5
  }'
```

| Column | Becomes | Note |
|---|---|---|
| `Queue_Lag1` (or `Queue_Length`, or J3's `Queue_Length_At_Arrival`) | `queue_lag1` | **the strongest single clue** |
| `Queue_Lag2` | `queue_lag2` | tells the model if the queue is growing |
| `Hour_Of_Day` or `Timestamp` | `hour` | **the service does the trigonometry** |
| `UC3_Truck_Inflow_Per_Hr` | `uc3_truck_inflow` | from UC-III cameras. Omit → training stand-in, disclosed |
| `Lanes_Open` | — | restates the wait at your real lane count |

> **J4 is the sheet to send.** It carries `Queue_Lag1`, `Queue_Lag2` and
> `UC3_Truck_Inflow_Per_Hr` directly, so **nothing is assumed and
> `degraded` is `false`.**

### Multi-hour curve

```bash
curl -X POST 'http://127.0.0.1:8200/uc2/webapp/m3/queue-curve?hours=12' \
  -H 'Content-Type: application/json' -d '{ ...same J4 row... }'
```

Returns `points[]` (each with `ts`, `stepAhead`, `p10/p50/p90`,
`deferralRecommended`) and ready-made `deferralWindows[]` to shade.

> This curve seeds from **your** lags, not from a corpus gate. That is why it
> works with JNPA gate IDs like `NSIGT-G1` — the native
> `GET /uc2/m3/forecast/{gate}` only knows the corpus gates `CFS` and `ECY`.

> **Charting rule.** Each step feeds its own output back in, so the band
> **widens by √step**. Never draw a constant-width ribbon.

### Get back

| Field | Meaning |
|---|---|
| `queueVehicles` / `p50` | **Trucks in the queue.** Never negative. |
| `p10` / `p90` | The band |
| `deferralRecommended` | **`true` = tell trucks to come later** (queue > 8) |
| `estimatedWaitMinutes` | Wait at the model's assumed 3 lanes |
| `estimatedWaitMinutesAtObservedLanes` | Wait at **your** `Lanes_Open` |

**Real output from the shipped sample** — all `degraded: false`:

| Gate | Hour | Lags | Queue | Band | Defer? | Wait @3 lanes | Wait @ real lanes |
|---|---|---|---|---|---|---|---|
| NSICT-G1 | 02 | 4 / 6 | **3.2** | 2.5 – 3.9 | no | 21 min | 21 min (3) |
| NSICT-G1 | 04 | 9 / 7 | **8.9** | 8.2 – 9.7 | **yes** | 60 min | 60 min (3) |
| GTI-G1 | 14 | 15 / 15 | **13.6** | 12.9 – 14.3 | **yes** | 90 min | 54 min (5) |
| NSIGT-G1 | 12 | 19 / 17 | **18.1** | 17.4 – 18.9 | **yes** | 121 min | 72 min (5) |

---

## 6. M4 — Anomalies (two different endpoints, know which you want)

### 6a. `/uc2/webapp/m4/event` — J9 row

J9 carries **flags an upstream detector already raised** (ISO mismatch,
duplicate document, truncated message) plus z-scores. Send the row, get
findings back under rule IDs `J9-F1…F7`, `J9-Z1`, `J9-Z2`.

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m4/event \
  -H 'Content-Type: application/json' \
  -d '{"Event_ID":"EVT-0002","Entity_Ref":"MSGU9266060","Terminal_Code":"NSICT",
       "Event_Timestamp":"2026-06-12 04:18","Source_System":"CODECO",
       "Numeric_Field_Non_Numeric_Flag":"Yes","Doc_Field_Mismatch_Flag":"Yes"}'
```

**Real output from the shipped sample:**

| Event | Entity | Worst | Findings |
|---|---|---|---|
| EVT-0001 | DPWU9011100 | WARN | `J9-F1` ISO size/type disagrees between manifest and gate move |
| EVT-0002 | MSGU9266060 | **CRIT** | `J9-F6` numeric field carries text · `J9-F2` doc field mismatch |
| EVT-0003 | 250720653 | WARN | `J9-F3` same physical document ingested twice |
| EVT-0004 | COARRI-CHUNK-4 | **CRIT** | `J9-F7` EDI message truncated, items lost |
| EVT-0005 | GESU4419077 | WARN | `J9-F5` out of sequence · `J9-Z1` dwell 2.4σ from mean |

> **These are not M4's R1–R6 rules.** `engine` says `j9_flag_passthrough` and
> `rulesNote` says so on every response, because claiming M4 *detected* an
> upstream flag would be a detection it never made.

### 6b. `/uc2/webapp/m4/trail` — M4's real lifecycle rules

To run R1–R6 (missing gate-out, LEO-no-move, negative dwell, …), send **every
row you hold for one container**. The service assembles the chronological trail.

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m4/trail \
  -H 'Content-Type: application/json' \
  -d '{"rows":[ {J1 row}, {J3 gate row}, {J6 facility row} ],
       "container":"DPWU9011100", "now":"2026-06-15T08:00:00Z"}'
```

Timestamps are read from `Arrival_DateTime`, `Gate_In_DateTime`, `CFS_In_TS`,
`CFS_Out_TS`, `ECY_Out_TS`, `Last_Out_TS`, `OOC_DateTime`,
`EDO_Issued_DateTime`, `Scanner_Stamp`, and `Move_Type` + `Truck_In_Time`.
Response includes `trailUsed` so you can see what it built.

**Real output** — J1 + J3 rows for `DPWU9011100`:

```jsonc
{ "eventCount": 2, "clean": true, "worstSeverity": null,
  "trailUsed": [ { "eventType": "GATE_IN",  "ts": "2026-06-07T08:27:00Z" },
                 { "eventType": "GATE_OUT", "ts": "2026-06-12T04:46:00Z" } ] }
```

That is the reconstruction the sheet's own README documents as the ground
truth — *"Hero A is real: 2026-06-07 08:27 → 2026-06-12 04:46 = 116.3 h"* —
assembled from two separate sheets with no manual joining.

> ### ⚠️ This endpoint silently returned nothing before 2026-08-03
>
> `uc2_corpus.parse_ts` accepted `2026-07-01T08:00:00` but **not**
> `2026-07-01T08:00:00Z` and **not** `2026-06-07 08:27` — the JNPA sheet's own
> declared format. `normalise_trail()` drops rows it cannot parse *silently*,
> so M4 handed a perfectly good broken trail answered **`clean: true`,
> `eventCount: 0`** — a false negative on an anomaly detector.
>
> Fixed at the root in `parse_ts`, so **every** model benefits, not just this
> endpoint. The corpus scan is unchanged (1,401 / 1,136 / 265), confirming the
> fix is purely additive. Regression-tested in the adapter self-test.

---

## 7. M5 — Berth Stay

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m5/vessel \
  -H 'Content-Type: application/json' \
  -d '{"row": {"Vessel_Name":"NORTHERN PRACTISE","VIA_Visit":"NTPS0633",
               "Terminal_Code":"NSICT","Export_Containers_On_EAL":1765,
               "Cranes_Allocated":4,"ETA":"2026-06-10 02:01",
               "Declared_Sailing_DateTime":"2026-06-15 08:01"},
       "moves_done": 400, "elapsed_h": 8.0}'
```

| Input | Source | Note |
|---|---|---|
| `row.VIA_Visit` / `VCN` | J10 | call identity |
| `row.Terminal_Code` | J10 | picks the crane-productivity assumption |
| `row.Export_Containers_On_EAL` + `Import_Containers_Manifested` | J10 | → `moves_total` |
| `row.Cranes_Allocated` | J10 | real crane count |
| **`moves_done`, `elapsed_h`** | **you, from TOS** | **omit → plan projection, not a live re-forecast** |
| `row.Planned_Stay_H` | **not in J10** | send it to get a variance and a status badge |

> ### ⚠️ `ETA` → `Declared_Sailing_DateTime` is **not** the berth plan
>
> On the JNPA rows those two bracket the **export receiving/cutoff window**.
> NORTHERN PRACTISE has `Gate_Open == ETA == 10 Jun 02:01` and sailing
> `15 Jun 08:01` — a 126 h span — while the same call's box count projects a
> **~20 h stay**. Reading 126 h as the plan yields a −106 h variance and an
> **"AHEAD"** badge an operator would act on and be wrong. J2 confirms the
> reading: the same span appears as `Hours_Gate_In_To_Cutoff` (138.6 h).
>
> So the adapter reports it as `declaredWindowHours` with a note, leaves
> `status` at `UNKNOWN`, and waits for a real `Planned_Stay_H`.

**Real output from the shipped sample:**

| Vessel | Terminal | Moves | Projected stay | Status |
|---|---|---|---|---|
| NORTHERN PRACTISE | NSICT | 1765 | **20.05 h** | UNKNOWN (no plan) |
| X PRESS PYXIS | BMCT | 587 | **7.64 h** | UNKNOWN |
| CMA CGM RIMBAUD | NSFT | 1200 | **12.40 h** | UNKNOWN |
| BSG BIMINI | NSICT | 21 | **2.61 h** | UNKNOWN ⚠️ |
| MSC SARA ELENA | NSIGT | 1456 | **13.60 h** | UNKNOWN |

BSG BIMINI's 21 moves come from a **scan list, not the full manifest** — the
adapter warns when `moves_total < 50` for exactly this reason.

**All five are `degraded: true` and `rateSource: "assumption"`** because the
corpus has no move-level crane productivity. Send `moves_done` + `elapsed_h`
from the TOS and `rateSource` flips to `"observed"`.

---

## 8. M6 — Lane Assignment

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m6/lanes \
  -H 'Content-Type: application/json' \
  -d '{"gate_rows":   [ ...J4 buckets AND J3 transactions... ],
       "vessel_rows": [ ...J10 calls... ],
       "closed_lanes": ["L6"]}'
```

| Source | Supplies |
|---|---|
| **J4 rows** (`Trucks_In_Last_Hour`) | the **hourly total** — a measured rate |
| **J3 rows** (`Move_Type`, `Container_Status`) | the **class mix** |
| **J10 rows** (`Reefer_Count`, `Hazardous_Count`) | reefer + hazmat demand, spread over 24 h |
| `closed_lanes` | operations input — not a sheet column |

> **Send both J4 and J3.** A J4 bucket states trucks *per hour*; a J3 row is
> *one transaction*. Summing them identically is the mistake that makes a
> saturated gate look idle. Sent alone, the five sample J3 rows report
> **7.6 trucks/h**; with the J4 buckets the same gate reports **149.6 trucks/h**
> — the difference between `status: OK` and `status: CRITICAL`.

**Real output from the shipped sample** (J4 + J3 + J10):

| | All lanes open | **L6 closed** |
|---|---|---|
| Demand | 149.62 /h | 149.62 /h |
| Capacity | 156.0 /h | 138.0 /h |
| Headroom | +6.38 | **−11.62** |
| Worst wait | 192 min | 225 min |
| Status | **CRITICAL** | **UNSERVABLE_DEMAND** |
| Unservable | — | **`{"HAZARDOUS": 1.42}`** |

| Lane | Load / capacity | Util | Wait |
|---|---|---|---|
| L1 Import | 51.03 / 30.0 | 1.70 | 192 min |
| L2 Import | 30.00 / 30.0 | 1.00 | 150 min |
| L3 Export | 17.92 / 28.0 | 0.64 | 3.8 min |
| L4 Export | 10.68 / 28.0 | 0.38 | 1.3 min |
| L5 Reefer | 22.00 / 22.0 | 1.00 | 150 min |
| L6 Hazmat | 18.00 / 18.0 | 1.00 | 150 min |

> **Render `unservableDemandPerHour` prominently.** L6 is the only hazmat lane
> and L5 the only powered lane. Close either and that traffic **has nowhere to
> go** — a plan that cannot execute, not merely a long queue.

---

## 9. M7 — Reefer Plugs and Empty Pool

### 9a. Reefer allocation

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m7/reefer \
  -H 'Content-Type: application/json' \
  -d '{"yard_rows":   [ ...J8 rows with Reefer_Plugs_Total / _Used... ],
       "vessel_rows": [ ...J10 rows with Reefer_Count... ],
       "cargo_rows":  [ ...J1 rows for the sensitivity mix... ],
       "plugs_failed": 18}'
```

| Input | From | Note |
|---|---|---|
| `Reefer_Plugs_Total` | J8 | **summed across your yard blocks.** The model's own default is the Container Parking Plaza's 96 — JNPA runs 120 (NSFT), 150 (NSICT), 180 (BMCT) |
| `Reefer_Plugs_Used` | J8 | **subtracted** — a plug under a box is not available to an arriving one |
| `Reefer_Count` | J10 | reefers about to land |
| `Nature_Of_Cargo` | J1 | → PHARMA / FROZEN / CHILLED / AMBIENT mix |
| `plugs_failed` | **you** | operations input, not a sheet column |

**Real output from the shipped sample:**

```
reefersArriving  125          (44+18+26+6+31 across the five calls)
plugsTotal       490          (120+150+40+180 — NOT the default 96)
plugsInUse       321          (74+88+18+141 already occupied)
plugsAllocatable 160
allocated        PHARMA 8 · FROZEN 37 · CHILLED 62 · AMBIENT 18
shortfall        0
status           OK
```

Plug priority is by how long the cargo holds temperature unplugged:
**PHARMA 4 h → FROZEN 8 h → CHILLED 12 h → AMBIENT 24 h.**
When boxes go unplugged, `hoursToFirstRisk` is the countdown for the duty
manager and `priorityEvacuation` is the action order.

### 9b. Empty pool balance

```bash
curl -X POST http://127.0.0.1:8200/uc2/webapp/m7/empties \
  -H 'Content-Type: application/json' -d '[ ...J8 rows... ]'
```

Reads `Empty_Boxes` (supply) and `Empties_Out_Last_24h` (demand) — **both from
the same rows**, so `daysCover` describes one consistent snapshot.

**Real output from the shipped sample:**

| Terminal | On hand | Daily demand | Days cover | Status |
|---|---|---|---|---|
| NSICT | 168 | 240 | 0.70 | **SHORT** |
| BMCT | 380 | 480 | 0.79 | **SHORT** |
| NSFT | 288 | 350 | 0.82 | **SHORT** |
| OFFDOCK (CFS) | 91 | 84 | 1.08 | **SHORT** |

`supplySource: "WEBAPP_J8"`, `demand_source: "caller"` — both from your rows.

> Send `Empty_Boxes`. Without it, supply falls back to the corpus inventory
> while demand comes from your rows, and the mixed calculation is meaningless —
> it previously produced 1662 days of cover at GTI and zero at NSFT, neither of
> which appears in either dataset. `supplySource` tells you which you got.

---

## 10. Building your dropdowns

```bash
curl http://127.0.0.1:8200/uc2/webapp/mappings
```

Returns every code table the adapter validates against: streams, lines, PCS
line codes, delivery modes, sidings, CTOs, movement classes, move types, cargo
sensitivity hold-hours, terminal crane productivity, the J9 flag rules, and
every named default. **Render your dropdowns from this** so a value the user
can pick is always a value the service can map.

---

## 11. Rules for rendering these outputs

1. **Never show a bare point.** Every forecast carries `p10`/`p50`/`p90`.
   A single number implies a confidence the model does not have.
2. **`degraded: true` must be visible.** Show a badge; put
   `mapping.assumptions[]` behind it so the user can see *what* was assumed.
3. **`decision_path` is the audit trail.** Info icon / hover.
4. **`mapping.derived[]` is the "why" drawer.** One line per model input:
   source column, raw value, rule, observed-or-assumed.
5. **`mapping.warnings[]` is actionable.** "Move_Type `X` is not in the table"
   means a real row is being dropped from the demand — surface it.
6. **On a 422, suspend.** The error names the field. Show
   *"suspended — awaiting `<field>`"*, never a stale or guessed number.
7. **Queue bands widen with horizon.** Never a constant-width ribbon.
8. **Render M6's `unservableDemandPerHour` loudly.** It is a plan that cannot
   execute.
9. **Render M2's assumption caveat.** No observed rake TAT exists to validate
   against.
10. **Badge M5's `rateSource: "assumption"`.** It means no live crane data yet.

---

## 12. What is still missing from the sheets

These are JNPA-side data gaps, not model defects. Each degrades gracefully.

| Gap | Hits | Effect today | Clears when |
|---|---|---|---|
| Move-level crane productivity | M5 | `rateSource: "assumption"`, fixed terminal rate | TOS crane logs ingested |
| Live `moves_done` / `elapsed_h` | M5 | plan projection, not a live re-forecast | web app sends TOS progress |
| `Planned_Stay_H` on J10 | M5 | no variance, `status: UNKNOWN` | berth plan column added |
| Plug fault count | M7 | assumes all plugs live | operations supplies it per call |
| Arrival cadence in a single row | M1 | 6.0 h default, `degraded: true` | **use `/m1/dwell-batch`** |
| UC-III truck inflow | M3 | training stand-in, disclosed | UC-III camera feed connected |
| Form 11 `.txt` (363 rail containers) | M2 | 3 sample rakes only | files ingested |

---

## 13. Verifying the install

```bash
python src/uc2_models/uc2_webapp_adapter.py --selftest   # 32 checks
python src/uc2_models/uc2_webapp_adapter.py --json       # predict every sample row
python run.py uc2                                        # all 7 native models
python run.py serve-uc2                                  # then open /docs
```

`--json` writes every prediction in this document. The saved copy is
[`out/uc2/webapp_predictions.json`](../out/uc2/webapp_predictions.json).

---

## Appendix — changes made for this data

The seven models' algorithms, coefficients and validation are **unchanged**;
their audited numbers stay audited. What changed:

| # | Change | Why |
|---|---|---|
| 1 | **New** `src/uc2_models/uc2_webapp_adapter.py` | the translation layer; 13 endpoints under `/uc2/webapp` |
| 2 | Mounted the adapter in `src/service/api_uc2.py` | so it ships with the service |
| 3 | **Fixed** M7 `plugs_failed` capped at 96 | rejected a legitimate 120-plug outage with 422; JNPA yards run up to 180 plugs |
| 4 | M5 no longer infers the berth plan from `ETA`→sailing | that span is the export cutoff window; it produced a −106 h variance and a false "AHEAD" badge |
| 5 | M6 separates rate rows from transaction rows | reading a J3 transaction as an hourly rate reported 7.6 trucks/h instead of 149.6 — `OK` instead of `CRITICAL` |
| 6 | M7 empty balance takes supply and demand from the same rows | mixing JNPA demand with corpus supply gave GTI 1662 days of cover |
| 7 | M1 batch endpoint measures arrival cadence across rows | single-row calls could only ever assume it |
| 8 | M2 falls back to `TEU ÷ 2` before the 1.15 boxes/wagon ratio | real JNPA rakes run 2.1 boxes/wagon; the old fallback halved the handling term |
| 9 | M3 curve seeds from caller-supplied lags | the native curve only knows the corpus gates `CFS`/`ECY`, not `NSIGT-G1` |
| 10 | **Fixed** `uc2_corpus.parse_ts` rejecting `…Z` and `YYYY-MM-DD HH:MM` | M4 dropped those events *silently* and answered `clean: true` — a false negative. Root fix, so every model benefits |

**Verification after every change** — 143 checks, no regressions:

```
m1 17/17 · m2 16/16 · m3 18/18 · m4 15/15 · m5 13/13 · m6 15/15 · m7 17/17
adapter 34/34        python run.py uc2 -> 7/7 models ran
M4 corpus scan unchanged: 1,401 scanned · 1,136 flagged · 265 clean
```

*Generated against the shipped code on 2026-08-03. Every column name, endpoint,
mapping rule and prediction in this document was read from the source and from
the regenerated `out/uc2/webapp_predictions.json`, not written from memory.*
