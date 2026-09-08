// FRWHOOP Strain V2 — display transform (v2.display.1)
//
// D5: a VERSIONED, monotone map from raw cardio AU to the user-facing 0-21
// "strain" axis. It is a UX transform only — NOT a physiological model. V1's
// 21*log(trimp+1)/log(7201) is retired (D5): the load -> adaptation evidence
// is roughly linear (r = 0.43-0.63, Clemente et al. 2025,
// doi:10.1186/s40798-025-00952-4), so heavy log compression flattens the very
// signal that best predicts adaptation (work_lit_cardio.md §0 contradiction #3).
//
// Design (defensible, single-parameter family):
//   score(au) = 21 * min(1, au / SCORE_SATURATION_AU) ^ POWER
//   POWER = 0.5 (square root): one compression step DOWN from V1's log toward
//   the near-linear adaptation evidence while keeping a usable 0-21 spread.
//   SCORE_SATURATION_AU = 480: chosen so a maximal ~2 h top-zone session
//   reaches 21 under every always-available model (see landmark table below);
//   the min(1, ...) clamp guarantees score in [0,21].
//
// Pure function: no I/O, no state, no randomness; 1-decimal rounding.
//
// LANDMARKS — reference AU ranges (minutes x per-minute weight at zone
// boundaries under each Model 3.1 model; arithmetic shown):
//
//   Stagno (default) per-minute weights 1.25/1.71/2.54/3.61/5.16 at
//   >=50/60/70/80/90 pct HRR (Stagno 2007 via Miguel 2021 table):
//     z1 50-60%:   30/60/90/120 min ->  38/ 75/112/150 AU  (1.25/min)
//     z2 60-70%:   30/60/90/120 min ->  51/103/154/205 AU  (1.71/min)
//     z3 70-80%:   30/60/90/120 min ->  76/152/229/305 AU  (2.54/min)
//     z4 80-90%:   30/60/90/120 min -> 108/217/325/433 AU  (3.61/min)
//     z5 90-100%:  30/60/90/120 min -> 155/310/464/619 AU  (5.16/min)
//   Edwards (V1 parity) weights 1-5:
//     z5 >=90%: 150/300/450/600 AU at 30/60/90/120 min; z1: 30/60/90/120 AU.
//   Banister continuous (dHR*a*e^(b*dHR), male a=0.64 b=1.92, Morton 1990):
//     dHR=0.60:  37/ 73/109/146 AU; dHR=0.80:  71/143/214/285 AU;
//     dHR=0.90:  97/195/292/389 AU (female 0.86/1.67: 42/84/126/169, 79/157/236/314,
//     104/209/313/417 AU).
//
//   Resulting scores (under this transform):
//     au   0 ->  0.0   (rest day / no load)
//     au  75 (60 min z1 stagno)      ->  8.3
//     au 150 (120 min z1)            -> 11.7
//     au 310 (60 min z5 stagno)      -> 16.9
//     au 480 (saturation)            -> 21.0
//     au 619 (120 min z5 stagno)     -> 21.0 (clamped)
//   Banister's absolute AU scale is lower (population-mean amplitude 0.64), so
//   a maximal Banister ~2 h session (~452 AU) maps to 20.4 — near-max, not
//   saturated; documented so year-over-year continuity is interpretable.

export const VERSION = 'v2.display.1';
export const DEFAULT_SATURATION_AU = 480;
export const DEFAULT_POWER = 0.5;

// v2.display.1 — pure monotone 0-21 mapping from cardio AU.
export function toDisplayScore(au, { saturationAu = DEFAULT_SATURATION_AU, power = DEFAULT_POWER } = {}) {
  const a = Number(au);
  if (!Number.isFinite(a) || a <= 0) return 0;
  const sat = Number(saturationAu) > 0 ? Number(saturationAu) : DEFAULT_SATURATION_AU;
  const p = Number(power);
  const exp = Number.isFinite(p) && p > 0 ? p : 1; // guard: keep monotone
  const frac = Math.min(1, a / sat) ** exp;        // clamp upper -> [0,21]
  const score = 21 * frac;
  return Math.round(score * 10) / 10;              // 1-decimal rounding
}

// Aliases for call sites that prefer explicit names.
export function display(au, opts) { return toDisplayScore(au, opts); }
export function strainV2(au, opts) { return toDisplayScore(au, opts); }

export default toDisplayScore;
