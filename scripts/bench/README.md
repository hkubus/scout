# Improvement benchmarks

Benchmarks that measure Scout on real data from an improvement export
(`scout-improvement-*.sqlite`, Settings → Data → Download improvement data, or
`GET /api/export/improvement`). Each one prints a metric table and, with
`--json=…`, writes a report that `compare.ts` can diff against a later run. Most
also work on a plain Scout database.

Run every script from the repository root:

```bash
node --import tsx scripts/bench/<name>.ts <export.sqlite> --json=before.json
# change code, or take a new export after the change ships
node --import tsx scripts/bench/<name>.ts <export.sqlite> --json=after.json
node --import tsx scripts/bench/compare.ts before.json after.json --threshold=5
```

Time windows are measured back from the export's `exported_at` (override it with
`--now=ISO`), so rerunning on the same file gives the same numbers. Every metric
says which direction counts as better. `compare.ts` exits with code 1 when a
metric gets worse by more than the threshold.

| Script | Measures | Runtime | Changes when |
| --- | --- | --- | --- |
| `perf.ts` | The real `ScoutService` on a scratch copy: every read behind the GET endpoints, the scheduler tick, the write path (`runWatch` with an injected adapter), duplicate refresh, retention prune, per-statement SQL time and query plans. `--heavy` adds exports, backup and the debug snapshot. `--apply=x.sql` tries out an index or a rewrite. | 40–110 s (+60–100 s with `--heavy`) | code changes |
| `perf-compact-check.ts` | Checks that an `--apply` SQL file leaves the app's reads unchanged: it diffs 40 reads before and after on one copy with a frozen clock. | ~30 s | — |
| `storage.ts` | Bytes per table, index and column; growth per week; redundant observation rows; size at steady state under the 180-day retention; tables that are never pruned. `--compact` tries the observation compaction on a copy. | seconds (+40 s with `--compact`) | new export |
| `scanning.ts` | Scan outcomes and error clusters, connector backoff, cadence slip, coverage gaps, OLX posting → first sighting, requests per new listing or deal, arrival rate by hour, listing lifetimes, effect of stored sessions. | ~4 s | new export |
| `alerts.ts` | Alert volume, delivery outcome and latency per channel, scan → alert → delivery, re-alerts, retries on permanent errors, alert quality, the ≥20% → alert funnel. | ~5 s | new export |
| `scoring.ts` | Baseline composition and stability, variant-rule mismatches, exclusions and flags, Strong+ feed and alert cleanliness, "net at typical" vs the flip ledger. | ~8 s | new export |
| `scoring-replay.ts` | Re-scores every listing at its first sighting with the repo's current `server/scoring.ts` under what-if scenarios (`--scenarios=`). It checks itself against `ScoutService.watchBaselines`. | 25–40 s | code changes |
| `ai.ts` | AI call volume, repeated calls, relevance, term-match rescue, description verification and vision, negotiability. Also how often deterministic rules (`flags.ts`, `text.ts`, `variants.ts`) already know the answer. Never calls a model. | ~4 s | new export; `ai.rules.*` also on code changes |

Helpers: `lib.ts` (Bench class, stats, `writableCopy`), `scan-lib.ts`,
`scoring-data.ts` (loaders plus a mirror of the baseline query), and
`perf-netguard.ts`. Candidate SQL for `perf.ts --apply`:
`perf-compact-observations.sql` (keep the first and last row of each same-day,
same-price run), `perf-index-scans-analytics.sql` and
`perf-index-observations-observed-at.sql` (both were tried and rejected; their
results are in the file headers).

## Safety

- The input file is opened read-only. Scripts that write (`perf.ts`,
  `perf-compact-check.ts`, `storage.ts --compact`) copy it to
  `SCOUT_BENCH_TMP` first and delete the copy when they finish. Point
  `SCOUT_BENCH_TMP` and `SQLITE_TMPDIR` at a disk directory, because the copy is
  200+ MB.
- No script reaches the network. `perf.ts` blocks every non-loopback call and
  stubs AI. The others only read SQL and run pure functions.
- Do not point these scripts at the live database while Scout is running. Use
  an export or a backup.

## Reading the numbers

- Marketplace prices are asking prices, not sales. "Gone" means the listing
  stopped appearing in a watch's results; it may have sold or been withdrawn.
- Ground truth is thin: a few flips, a few dozen hide or pass actions, and no
  negotiation outcomes yet. Rates built on them are anecdotal until the ledger
  grows.
- `perf.ts` timings move 2–3× with host load. Compare candidates by running the
  baseline and the candidate alternately, not against an old report.
