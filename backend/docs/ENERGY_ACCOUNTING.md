# Canonical energy accounting specification

This is the single, enforced definition of every energy quantity FRWHOOP computes.
It is asserted in code (`energy/accounting.js`) and in tests, so gross and active
calories can never become interchangeable and resting energy is never silently
included in one workout number and excluded in another.

## Accounting identity (per minute)

For every wall-clock minute:

    total_kcal        = resting_kcal + active_kcal + tef_kcal

- **resting_kcal**  — cost of being alive for that minute. RMR/1440, or the
  sleeping rate during sleep (0.95 × RMR). Allocated continuously; a strap gap
  does not make it zero, it is projected.
- **active_kcal**   — physical-activity energy above resting: total − resting − tef,
  floored at zero. This is PAEE at minute resolution.
- **tef_kcal**      — thermic effect of food allocated to that minute, usually 0 at
  minute resolution (see daily accounting). Stored separately so it can never be
  double counted.
- **total_kcal**    — physiological TDEE contribution of that minute. A generated
  column; cannot disagree with its parts.

## Definitions (enforced vocabulary)

| Term | Definition |
|---|---|
| RMR | Resting metabolic rate, kcal/day, measured or predicted (Mifflin/Katch). The awake resting baseline. |
| REE | Resting energy expenditure — what RMR allocates to minutes on top of/mostly sleep-adjusted. Used interchangeably with "resting energy" at daily scale. |
| BMR | Basal metabolic rate, the minimum maintenance cost, ≤ RMR. Not separately used by the model; documented to avoid conflation. |
| RMR vs BMR | The model predicts RMR unless the user provides a measured value. BMR is not an output. |
| PAEE | Physical activity energy expenditure = active_kcal (sum of per-minute active). |
| NEAT | Non-exercise activity thermogenesis — PAEE arising outside structured workouts. NEAT = active − workout. |
| Exercise / workout energy | active_kcal on minutes inside a detected workout. A subset of PAEE, never additional. |
| Gross workout | resting + active on workout minutes (the total during the session). |
| Net workout (above rest) | active on workout minutes = gross − resting(session). |
| TEF | Thermic effect of food (a.k.a. diet-induced thermogenesis). Positive only in the daily total when nutrition data is sufficient; otherwise a conservative population prior is included when physiological-TDEE display is chosen. |
| TDEE | total daily energy expenditure = resting + PAEE + TEF (+ any separately modeled thermogenesis). At minute resolution the equivalent is total_kcal. |
| NEAT (daily) | active_kcal − workout_active_kcal. |

## Gross vs net workout

Energy_workouts stores **both** internally:
- `resting_kcal` — the resting baseline over the session (gross − net).
- `active_kcal`  — the net-above-rest workout energy.
- `total_kcal`   — gross = resting + active.

The frontend displays the net (active) workout number as "active/workout calories",
which is what consumers expect to compare against "active calories" elsewhere.
The gross number is always available in diagnostics so no meaning is lost.

## TEF

WHOOP does not include TEF. FRWHOOP's default display is **physiological TDEE**
(diets' total), so we must decide what to do with TEF:

- When sufficient macro information exists for a day, estimate TEF from
  macronutrient-specific ranges (protein ~20–30%, carbohydrate ~5–10%, fat
  ~0–3% of that nutrient's kcal). Ranges are from primary literature and are
  reported as uncertainty, not as a point.
- When nutrition data is absent, include a conservative population prior
  (~10% of intake) only if the longitudinal energy-balance model supplies it,
  so we never invent precision.
- TEF is stored in its own column and never folded back into resting or active,
  so the longitudinal food/weight filter (which already estimates TDEE including
  TEF) cannot double count it.

## Longitudinal / energy-balance identity

The independent energy-balance (food+weight) estimator produces its own TDEE
estimate **excluding** the sensor model. If the two are later fused, TEF is added
at most once — wherever it lives, the fused output must not add it a second time.

## Invariants (asserted in tests and by DB generated columns)

1. `total == resting + active + tef` per minute.
2. `workout_active <= active` at every aggregation level (workout is a filter).
3. `NEAT == active − workout_active` >= 0.
4. Resting kcal is never negative; a minute can't burn less than being alive.
5. TEF is never added twice: the sensor minute total and the longitudinal TDEE
   both exclude TEF unless explicitly and singly including it.
