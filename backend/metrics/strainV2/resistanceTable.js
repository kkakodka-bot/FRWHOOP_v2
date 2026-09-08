/**
 * Body-mass contribution to effective moving mass, per exercise family.
 * UNVALIDATED body-segment heuristics (Dempster 1955 / Winter 2009), carried
 * with an explicit evidence flag; calibrate per exercise before any scientific
 * use. Values are fractions of body mass added to external load.
 * Unknown families carry null — the feature is suppressed rather than guessed.
 */
export const BODY_MASS_FRACTIONS = Object.freeze({
  squat: { value: 0.70, evidence: 'heuristic_0.60-0.80_unvalidated' },
  deadlift: { value: 0.0, evidence: 'external_load_only_bar_path' },
  bench: { value: 0.15, evidence: 'heuristic_0.10-0.20_unvalidated' },
  overhead_press: { value: 0.0, evidence: 'external_load_only_stabilizers_unmodeled' },
  row: { value: 0.10, evidence: 'heuristic_unvalidated' },
  pullup: { value: 1.0, evidence: 'full_body_mass_lifted' },
  pushup: { value: 0.65, evidence: 'heuristic_unvalidated' },
  lunge: { value: 0.40, evidence: 'heuristic_unvalidated' },
  unknown: { value: null, evidence: 'no_basis_feature_suppressed' },
});

const EXERCISE_FAMILY_RE = [
  ['deadlift', /deadlift|rdl|romanian|hip thrust|hipthrust/i],
  ['bench', /bench|chest press|db bench|barbell bench/i],
  ['overhead_press', /(overhead|military|shoulder) press|\bohp\b/i],
  ['squat', /squat|goblet|leg press/i],
  ['row', /\brow\b|lat ?pulldown|seated row/i],
  ['pullup', /pull ?-?up|chin ?-?up/i],
  ['pushup', /push ?-?up/i],
  ['lunge', /lunge|split squat|step ?-?up/i],
];

export function exerciseFamily(name) {
  const s = String(name || '');
  for (const [family, re] of EXERCISE_FAMILY_RE) {
    if (re.test(s)) return family;
  }
  return 'unknown';
}

export const RESISTANCE_SUBSYSTEM_VERSION = 'strainV2.resistance.0.experimental';
