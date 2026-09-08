# Third-party notices (VO2 Max engine)

FRWHOOP is MIT-licensed. This module cites public science and inspected
open-source projects. It does **not** copy GPLv3 or Apple-licensed source, and
it does not vendor PhysioNet data.

| Resource | License | What we did |
|---|---|---|
| GenieMax Core | MIT | Inspected as a reference for Uth / Tanaka. Formulas reimplemented from the **published papers**. Swift is not in this tree. |
| sdimi/cardiofitness | GPLv3 | **Not copied.** Paper used as a scientific reference for feature *concepts* only. No pretrained network in-repo. |
| apple/ml-heart-rate-models | Apple source license, no patent grant | **Not copied.** Research reference for HR-vs-workload structure. GPS v1 is independent ACSM + %HRR. |
| SeanPresent/VO2max_Estimation | GitHub license unset (claimed CC BY 4.0; unverified) | **Not copied.** Independent parser + metrics. Cite dataset/paper only. |
| PhysioNet Málaga CPET (Mongin et al. 2021) | PhysioNet restricted DUA 1.5.0 | Dataset **not vendored**. Optional offline parser; CI uses synthetic fixtures. |
| Firstbeat public white paper | Public methodology | Segment reliability + HR vs workload **concepts**. No proprietary constants. |
| Jackson 1990; Tanaka 2001; Uth 2004; ACSM metabolic equations; Swain 1997 | Published papers | Explicit formulas in `methodology.js` / `exercise.js` / `uth.js`. |
| WHOOP public VO2 Max materials | Public product documentation | Eligibility / weekly cadence / published MAE as **behavior to reconstruct**, not a copied algorithm. |

If a future contributor wants to add a third-party weight file or copy
external source, it must be MIT-compatible and listed here **before** merge.
