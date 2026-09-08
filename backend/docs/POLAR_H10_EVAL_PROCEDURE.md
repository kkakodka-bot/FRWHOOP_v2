# Polar H10 ground-truth collection & evaluation procedure

Scope: FRWHOOP HR V2 evaluation (V2_DESIGN.md §2 "eval/", this file). The Polar
H10 chest strap is the accepted practical ECG proxy for wrist-worn HR
validation — RR-interval signal quality 99.6% vs Holter ECG across rest to
high-intensity activity, HRV effectively interchangeable with lab ECG, and
moment-to-moment Pearson r > 0.99 vs ECG (citations and limits:
`_hr_v2_research/ppg_hr_accuracy_research.md` §5.1).

Equipment: Polar H10 + Polar Beat (or Polar Flow app), fresh CR2025, fully
charged WHOOP strap with recent firmware, and a phone clock that is
NTP-synced (offset < 1 s) for the receive-side timeline.

---

## 0. Files this enables

All infrastructure already exists; this document is the data-collection playbook
that produces the inputs it ingests.

| File | Purpose |
|---|---|
| `backend/hr2/eval/reference.js` | `parseReference()` — Polar CSV / JSON / RR txt → `{samples:[{t, hr, rr_ms?}]}` |
| `backend/hr2/eval/align.js` | `alignReference()` — HR cross-correlation (default ±120 s, 1 s step) + linear drift fit → `{offset_ms, drift_ppm, residual_std_ms, n_pairs}` |
| `backend/hr2/eval/metrics.js` | `comparisonMetrics()` + `stratify()` — MAE/RMSE/MAPE/bias/LoA/CCC/Pearson/within-±3/5/10/20/large-error/coverage/abstention/transition-lag |
| `backend/hr2/eval/split.js` | `personSplit()` — person-level train/test for any future trained model |
| `backend/scripts/clockCharacterize.mjs` | strap RTC offset/drift report (already run; `backend/docs/CLOCK_CHARACTERIZATION.md`) |
| §8 runner | the exact CLI that compares a session once data lands |

Accepted Polar export formats (documented contract, all in `reference.js`):

1. **Polar Flow CSV** — any header row whose columns include a time column
   (`time`, `local time`, `timestamp`, `datetime`, …) and an HR column
   (`HR`, `heart rate`, `bpm`, `heart rate (bpm)`, …); an optional separate
   `date` column and `RR`/`rr (ms)` column are recognised. Session-metadata
   preamble lines / quotes are tolerated. Naive HH:MM:SS rows need either a
   date column or `--tz-ymd` session date.
2. **JSON** — `{ "samples": [ { "t": <ISO|epoch-ms>, "hr": 60, "rr_ms": 1000 } ] }`
   (`bpm` is an accepted alias; `t` accepts epoch-ms/epoch-s).
3. **RR txt (Polar-accessor style)** — one RR interval per line (ms; values
   < 200 treated as seconds), start time from `# start: <ISO>` comment,
   `options.startTime`, or a timestamp in the filename. RR-only rows get a
   derived 1 s HR (60e3/rr_ms) so they can participate in alignment.

Robustness (all paths): gaps tolerated, duplicate timestamps collapsed with a
stable first-occurrence rule, out-of-order rows sorted deterministically,
naive timestamps interpreted as UTC unless a fixed offset (`+02:00`, `UTC+2`)
is given. Malformed input returns `{ok:false, reason}` — never throws.

---

## 1. Recording setup (once per session)

1. Phone: `Settings > Date & Time` — Automatic time on; verify server sync.
   Record the phone offset vs `time.is` before and after each session.
2. WHOOP: wear on the wrist you intend to validate; secure the band; verify the
   strap shows live HR in the app (phone receive timestamps = `datetime` in
   `backend/data/live/<userId>/YYYY-MM-DD.ndjson`).
3. Polar H10: wet the electrodes, position the strap under the pectoral band,
   pair in Polar Beat, and start **Heart rate** mode:
   `Beat > Settings > Recording > R-R 1s` (this stores beat-level RR; the 1 s
   HR stream is exported from it). Confirm the H10 is transmitting (solid
   chest icon) before starting the protocol.

## 2. Session protocol per activity

Run each activity as its own session block with a quiet 60 s lead-in and 60 s
lead-out at rest, so the alignment cross-correlation has low-noise anchors.
Block protocol follows the wearable-validation literature block design
(`ppg_hr_accuracy_research.md` §5.2).

| activity | duration | protocol |
|---|---|---|
| rest_supine | 5 min | lying still, no talking, eyes closed |
| rest_seated | 5 min | seated still, relaxed, hands on thighs |
| sleep | ≥ 4 h overnight | normal sleep, H10 worn, no workout |
| walk | 5 min | treadmill 4–6 km/h, arms free |
| run | 5–8 min | 8–13 km/h steady (or outdoor, steady pace) |
| cycle | 5 min | stationary bike, steady ~120–150 W cadence locked |
| lift | 3 × 10 RM | resistance circuit (e.g., squat, press, row, deadlift) with 60 s rest between sets |
| hiit | 5 min | burpees/box jumps/rapid transitions — worst-case motion artifact |

Sampling: H10 1 s RR mode throughout (not session-summary mode); WHOOP live HR
stream records automatically to `backend/data/live`.

## 3. Sync marker procedure (verification, not requirement)

`alignReference()` recovers an unknown constant offset + drift automatically, so
markers are an independent check, not a hard requirement. Do both:

1. **Time marker** — at session start, on a spoken cue, tap the WHOOP strap 3
   times at 1 s intervals AND do 5 rapid deep breaths (loud, exaggerated). The
   strap motion spike is visible in `step_cadence`/`motion`; the H10 RR spike is
   visible in `rr_ms`. Record the wall-clock second of the cue in a notebook.
2. **Edge marker** — repeat the same at session end.
3. Store markers per session in `backend/data/h10_ref/<session_id>/markers.ndjson`:
   `{"t":"<iso ts of cue>","kind":"breath_5x","note":"start"}`
   (used only to sanity-check `alignReference().offset_ms`, never as the
   alignment itself.)

**Reading the alignment result (important).** `alignReference()` cross-correlates
the HR *values*, so its `offset_ms` is the offset that makes the two value
streams coincide — that is *clock offset + sensor/RR-processing + BLE delivery
latency* combined. For error metrics this value-alignment is the CORRECT one to
use (it pairs each physiological instant with the WHOOP reading that describes
it). The wall-clock marker offset from §3 differs from `alignReference().offset_ms`
by exactly that pipeline latency; report the delta as `latency_ms =
offset_ms(align) − offset_ms(marker)` per session. In the §8 synthetic check the
recovered offset is ≈ 40 s when the wall-clock offset was 37 s and the WHOOP
value stream was 3 s late — the extra 3 s is pipeline latency, not clock error
(`residual_std_ms` ≈ 88 ms shows the residual fit is tight).

## 4. Export

1. Polar Beat / Polar Flow → session → **Export**:
   - "Export HR" → `session.csv` (columns `Local time,Heart rate` or similar);
   - if the session recorded RR: "Export R-R" → `session_rr.txt` (one RR per line).
2. Save all three candidate inputs (`session.csv`, `session.json` if produced,
   `session_rr.txt`) into:

   ```
   backend/data/h10_ref/<session_id>/
     session.csv          # Polar Flow HR export (preferred)
     session_rr.txt       # RR txt (optional but recommended — beat reference)
     markers.ndjson       # sync markers (§3)
     activity.json        # {"activity":"run","subject":"<user_id>","date":"YYYY-MM-DD",
                          #  "whoop_user": "<uuid>", "notes":""}
   ```

   Layout is free-form (the parser takes explicit paths); this is the suggested
   convention and what the §8 runner expects by default.

## 5. Ingest + run the comparison

The runner is a self-contained `node --input-type=module` script (no new
dependencies) that:

1. `parseReference(session.csv|json|rr_txt)` → reference model;
2. reads the WHOOP observations for the same local day from
   `backend/data/live/<whoop_user>/<date>.ndjson` (or an explicit `<obs>` path);
3. `alignReference(reference, observations)` → offset/drift/residual;
4. forms 1 s reference-vs-estimate pairs inside the aligned overlap
   (`t` from reference, `est_bpm` from WHOOP at `t + offset`), skipping WHOOP
   rows that lack HR;
5. `comparisonMetrics(pairs, {totalExpected})` + `stratify(pairs,'quality')`
   and writes `docs/H10_REPORT.md`.

### Expected results file (`docs/H10_REPORT.md`)

Per session and aggregated per activity: n, MAE, RMSE, MAPE (+skipped), bias,
Bland–Altman LoA, CCC, Pearson, % within ±3/±5/±10/±20, |err|>20 rate,
coverage, abstention, transition lag, and the alignment report
(`offset_ms`, `drift_ppm`, `residual_std_ms`, `method`, `n_pairs`).

## 6. Acceptance criteria (before any accuracy claim)

Per `ppg_hr_accuracy_research.md` §5.2 the minimum campaign is:

- **subjects** ≥ 20 healthy adults (diverse skin tone / BMI / wrist
  circumference documented per Nelson 2020 device-reporting guidance);
- **sessions** ≥ 2 per activity block (≥ 60 total sessions);
- **duration** 5 min per acute block, ≥ 4 h for one overnight sleep per subject
  where sleep is a target strata;
- **activity coverage** all of: rest_supine, rest_seated, sleep, walk, run,
  cycle, lift, hiit — missing a block is a coverage gap, not "pass" for that
  block;
- **H10 quality gate**: per-session RR artifact fraction < 5%
  (`rrStats()`-style 20 % rule from `backend/signal/quality.js`);
- **alignment gate**: `alignReference().ok`, `residual_std_ms <= 1000 ms`,
  `n_pairs >= 300`, not `at_window_edge`;
- **report set** must be emitted for every block and reported as a separate
  stratum (never pooled across people as independent observations — Bland &
  Altman 2007 repeated-measures caution): per-participant aggregation first,
  then population summary.

No accuracy claim (`calibrated` stays `false`; no "X bpm typical error") is
valid until these gates pass. Claims then use only the metrics report set in
§5.2, identical to the `comparisonMetrics()` output.

## 7. Data-handling notes

- `alignReference` treats the reference clock as *not* authoritative: it
  quantifies `offset_ms`/`drift_ppm`/`residual_std_ms` and exposes them rather
  than silently shifting. If `at_window_edge` is true, rerun with a larger
  `maxOffsetSec`.
- WHOOP `datetime` in `data/live` is the receive-side clock; the strap's own
  RTC does not appear in the live stream (straps: `CLOCK_CHARACTERIZATION.md`).
- For offline WHOOP observations that carry `t_strap` and `clock_offset_sec`
  (history path), pass those timestamps directly to the runner's observation
  reader so the same align/metrics pipeline works unchanged.

## 8. Exact CLI / runner

Save the block below as `backend/scripts/runH10Comparison.mjs` and run:

```
cd backend
node scripts/runH10Comparison.mjs data/h10_ref/<session_id>/session.csv \
    --whoop-user <user-uuid> --date 2026-08-27 \
    --activity run --subject <subject-id> \
    --out docs/H10_REPORT.md
```

Options: `--tz +02:00` (naive CSV timestamps), `--tz-ymd 2026-08-27` (session
date for HH:MM:SS-only CSVs), `--max-offset-sec 300`, `--align-out
docs/H10_ALIGN.json`. Run with no `--whoop-user` but a positional `<obs-path>`
to compare against an explicit observation ndjson instead of the live store.

```js
// backend/scripts/runH10Comparison.mjs — documented inline runner (no deps)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { parseReference } from '../hr2/eval/reference.js';
import { alignReference } from '../hr2/eval/align.js';
import { comparisonMetrics, stratify } from '../hr2/eval/metrics.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const [refPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const whoopUser = arg('--whoop-user', null);
const dateArg = arg('--date', null);
const strategy = arg('--activity', 'unknown');
const subject = arg('--subject', 'dev');
const tz = arg('--tz', undefined);
const tzYmd = arg('--tz-ymd', undefined);
const outFile = arg('--out', path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'docs', 'H10_REPORT.md'));

if (!refPath) { console.error('usage: node scripts/runH10Comparison.mjs <reference.(csv|json|txt)> [--whoop-user u|path.ndjson] ...'); process.exit(2); }

/** Load WHOOP observations (live ndjson rows or canonical {t,tMs,hr/bpm}). */
function loadObservations() {
  if (!whoopUser) { console.error('--whoop-user <uuid> or <path.ndjson> required'); process.exit(2); }
  const p = existsSync(whoopUser) ? whoopUser
    : path.join(process.cwd(), 'data', 'live', whoopUser, `${dateArg}.ndjson`);
  if (!existsSync(p)) { console.error('no observations at', p); process.exit(3); }
  const obs = [];
  for (const ln of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(ln);
      const t = Number.isFinite(o.t) ? o.t : Date.parse(o.datetime ?? o.t);
      const bpm = o.bpm ?? o.hr;
      if (Number.isFinite(t) && Number.isFinite(bpm)) obs.push({ t, hr: bpm, quality: o.q_reported ?? null, motion: o.motion ?? null, activity_class: o.activity_class ?? null });
    } catch { /* skip */ }
  }
  return obs;
}

// 1) reference
const opts = {}; if (tz) opts.timeZone = tz; if (tzYmd) opts.date = tzYmd;
const ref = parseReference(readFileSync(refPath, 'utf8'), opts);
if (!ref.ok) { console.error('reference parse failed:', ref.reason, ref.meta?.warnings); process.exit(4); }

// 2)+3) observations + alignment. NOTE: we keep the VALUE alignment on
// purpose — offset_ms here = clock offset + WHOOP pipeline latency, the
// pairing that makes per-instant error metrics meaningful (see §3).
const obs = loadObservations();
const align = alignReference(ref, obs, { maxOffsetSec: Number(arg('--max-offset-sec', '300')) });
if (!align.ok) { console.error('alignment failed:', align.reason); process.exit(5); }

// 4) 1 s pairs in the aligned overlap
const bySecond = new Map();
for (const o of obs) bySecond.set(Math.floor((o.t - align.offset_ms) / 1000), o); // obs time shifted so ref==obs
const pairs = [];
for (const s of ref.samples) {
  const o = bySecond.get(Math.floor(s.t / 1000));
  if (!o) continue; // gap
  pairs.push({ t: s.t, ref_bpm: s.hr, est_bpm: o.hr, quality: o.quality, motion: o.motion, activity_class: o.activity_class });
}

// 5) metrics + strata
const m = comparisonMetrics(pairs, { totalExpected: ref.samples.length });
const byAct = stratify(pairs, 'activity_class');
const byQual = stratify(pairs, 'quality');
const md = [
  '# H10 vs WHOOP — session report',
  `reference: \`${refPath}\` · activity: ${strategy} · subject: ${subject} · pairs: ${m.n}`,
  '',
  '## Alignment', `\`\`\`json\n${JSON.stringify(align, null, 2)}\n\`\`\``,
  '## Metrics', `\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\``,
  '## By activity_class', `\`\`\`json\n${JSON.stringify(byAct, null, 2)}\n\`\`\``,
  '## By quality', `\`\`\`json\n${JSON.stringify(byQual, null, 2)}\n\`\`\``,
].join('\n');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, md);
console.log('wrote', outFile, '| mae', m.mae, 'bias', m.bias, 'ccc', m.ccc, 'coverage', m.coverage);
```

Verification of the runner against synthetic data (before real data lands):

```bash
cd backend
node --input-type=module -e '
import { writeFileSync } from "node:fs";
const T0 = Date.UTC(2026,7,25,12,0,0);
const ref=[]; const obs=[];
for (let s=0;s<1800;s+=1){const hr=60+10*Math.sin(s/40)+(s>=300&&s<600?30:0)+(s>=900&&s<1200?20:0);
  ref.push({t:T0+s*1000,hr});
  if(s>=3) obs.push({datetime:new Date(T0+s*1000+37000).toISOString(),bpm:ref[s-3].hr});
}
writeFileSync("/tmp/h10_test.csv", "Local time,Heart rate\n"+ref.map((r,i)=>(
  new Date(r.t).toISOString().slice(11,19)+","+Math.round(r.hr))).join("\n"));
writeFileSync("/tmp/whoop_obs.ndjson", obs.map(o=>JSON.stringify(o)).join("\n"));
'
node scripts/runH10Comparison.mjs /tmp/h10_test.csv --whoop-user /tmp/whoop_obs.ndjson --activity test --tz-ymd 2026-08-25 --out /tmp/H10_TEST.md
# expect: alignment offset_ms ≈ +37000, bias ≈ 0, mae low (twice the 10 bpm sinusoid).
