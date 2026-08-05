# The UC-II cargo-handling corpus is NOT in this repository

**Decision:** excluded. **Cost:** measured and listed below, not guessed.

The WS2 delivery ships a 43 MB read-only document tree at
`data/corpus/UC-II_Cargo_Handling/`. It is not committed here. This file is the
record of that choice and of exactly what it takes away, so nobody has to
rediscover it from a red test run.

## Why it is excluded

This repository is 6.9 MB of git history. The corpus is 43 MB of binary
spreadsheets, fixed-width text and XML that never change — committing it would
make the tree seven times larger permanently, and git cannot delta-compress
`.xlsx`. Every clone, every CI checkout and every branch would pay for data that
only the model service reads.

**This is a different decision from UC-1's, and for a different reason.** UC-1
excluded its 44 MB DSR corpus because everything the models needed had already
been reduced into a tracked CSV: nothing degraded, no test needed it. That is
not true here. `src/pipeline/uc2_corpus.py` reads the raw tree directly and six
of the seven models degrade without it. So the cost below is real, and it is
paid every time this service runs in this checkout.

## What degrades, precisely

Run `python run.py corpus` to see it live. With the corpus absent, all 13
sources report `MOCK` / `degraded: true` — never a confident zero — and:

| Model | What it loses | What it does instead |
|---|---|---|
| **M1** dwell | 254 real container stays; the CFS-CODECO 483 IN→OUT pairs | `FALLBACK_CALIBRATION`. **Only the 3.69 h synthetic MAE is computable. The 21.36 h real-corpus figure — the one that loses to a 15.74 h median baseline — cannot be recomputed here.** It is still published from the model card, and it is still the honest number. |
| **M2** rake TAT | 67 real rakes, the CTO manifests, the FOIS intimations | `FALLBACK_COMPOSITION`. `validate_against_corpus()` returns `unavailable` instead of `exercised_not_scored`. Its metric is still **fidelity, never accuracy** — there was no observed rake TAT to be accurate to even with the corpus. |
| **M3** gate queue | the real gate series | a synthetic series, badged `SYNTHETIC` in `decision_path`. The rolling-origin split protocol is unchanged; the numbers describe generated traffic. |
| **M4** event anomaly | the planted ECY-CODECO anomalies (432 gate-ins with no gate-out, 287 orphan gate-outs) | scans nothing from the corpus. **The R1–R6 trail rules still run in full on rows the caller POSTs** — which is what the Predictions panel actually uses, since it sends the container's own event chain. |
| **M5** berth stay | 5 TOS vessel calls; `dsr_berth_stays.csv` | assumed crane rates, `degraded: true`. |
| **M6** lane assignment | nothing | deterministic allocator, no corpus input. **Unaffected.** |
| **M7** empty pool / reefer | ~4,700 EAL/IAL inventory lines across 9 files | `degraded: true`, "no inventory parsed". |

**The panel still works end to end.** Every degraded figure arrives with
`degraded: true` and a `decision_path` naming the fallback, and the UI renders
that badge — which is the whole reason the badge exists.

## What this costs the test suite

`pytest -q` is **clean** on this checkout: 73 passed, 6 skipped, 0 failed.
`python tools/selftest_gate.py` is clean too: 9/9 modules, 12 checks not
exercised.

Six tests carry `@needs_corpus` and skip with the reason "UC-II corpus not
present in this checkout". The nine module self-tests still run, and still
assert every check that does not depend on the corpus — the corpus-dependent
checks are exempted **individually and printed**, so a green run still states
exactly what it did not exercise:

```
[PASS] UC2-M4  12/15  (3 corpus-dependent not exercised)
       - not exercised: planted anomalies found -- by type: None
```

`tools/selftest_gate.py` is the single definition of that exemption; the test
suite imports it and the Docker build runs it, so the two cannot drift into
disagreeing about what "passing" means here. **The exemption is narrow**: it
matches each module's own failure text, so a check that fails for any other
reason still fails the build. Verified by injecting a non-corpus failure — the
gate exits 1 and pytest goes red. With the corpus present, nothing is exempted
at all.

Note two exempted checks whose text does not name the corpus. The adapter's
"row … is NOT degraded [assumptions=[]]" pair look like translation failures but
are not: the empty assumption list is the proof that the adapter assumed
nothing, and the degradation came from the MODEL running on a fallback
calibration or a synthetic series — that is, from missing data.

`test_corpus_absence_is_reported_not_hidden` is the guard in the other
direction: with the corpus gone, every loader must say `MOCK`/`degraded`,
because a loader returning 0 rows with `degraded: false` would let the panel
render an empty pool as a balanced one.

## How to restore it

Copy the tree in and everything above reverses with no code change:

```bash
cp -R "<delivery>/data/corpus/UC-II_Cargo_Handling" ml/data/corpus/
ml/.venv/bin/python ml/run.py corpus     # should report 13/13 real
ml/.venv/bin/python -m pytest -q         # 79 passed, 0 skipped
```

`.gitignore` keeps it untracked, so restoring it locally does not risk
committing it by accident.
