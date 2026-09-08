/**
 * Frozen external score for HAbitsLab in-lab cart data. Does not fit.
 * Run: node energy/v3/evaluateHabits.mjs
 */
import { discoverInlab, HABITS_ZENODO, HABITS_DOI } from './habitsInlab.js';

const info = discoverInlab();
const report = {
  dataset: 'HAbitsLab Wrist-Based EE Estimation in-lab',
  zenodo: HABITS_ZENODO,
  doi: HABITS_DOI,
  license: 'CC BY 4.0',
  ground_truth: 'metabolic_cart_only',
  refused: ['Study_Information-style Compendium MET', 'Ainsworth MET', 'in-wild / free-living as cart GT'],
  tune: false,
  ...info,
};
if (!info.ok) {
  report.harness = 'ready_waiting_for_local_extract';
}
console.log(JSON.stringify(report, null, 2));
