/**
 * Deterministic GBM tree evaluator for Energy v2 (shadow candidate runtime).
 *
 * Accepts the exported LightGBM model JSON (booster.dump_model()):
 *   { trees: { tree_info: [ { tree_structure: {...} } ], feature_names: [...] },
 *     feature_names: [runtime names], scale, base_score, clip }
 * or a pre-flattened { trees: [ {tree_structure} ] }.
 *
 * Missing-value serve contract (deterministic, portable — see artifact
 * `missing.replacement_min`): any null feature is replaced by its per-feature
 * TRAINING MINIMUM before traversal. LightGBM's raw NaN routing for features
 * that never saw NaN in training is not derivable from the dump, so the
 * deployed evaluator uses fill-then-compare; for '<=' splits this routes
 * nulls to the low-value branch, matching native default_left on most nodes.
 * The numeric split itself is LightGBM's `value <= threshold`.
 *
 * Pure functions, no I/O in the prediction path.
 */

import { clamp } from '../constants.js';

function isTreeList(trees) {
  return Array.isArray(trees);
}

function treesOf(artifact) {
  if (Array.isArray(artifact.trees)) return artifact.trees;
  if (artifact.trees && Array.isArray(artifact.trees.tree_info)) return artifact.trees.tree_info;
  if (Array.isArray(artifact.tree_info)) return artifact.tree_info;
  return null;
}

export function loadV2Gbm(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const trees = treesOf(artifact);
  if (!trees || trees.length === 0) return null;
  const featureNames = artifact.feature_names ?? artifact.features ?? null;
  const scale = Number.isFinite(artifact.scale) ? artifact.scale : 1;
  const base = Number.isFinite(artifact.base_score) ? artifact.base_score : 0;
  if (!trees.length) return null;
  return {
    trees: trees.map((t) => t.tree_structure ?? t),
    names: featureNames,
    scale,
    base,
    clip: artifact.clip ?? null,
    conformal: artifact.conformal ?? null,
    replacementMin: artifact.missing?.replacement_min ?? null,
  };
}

/** @returns {met, raw} or null */
export function predictV2Gbm(model, features) {
  if (!model || !features) return null;
  let sum = model.base;
  for (const tree of model.trees) {
    const v = traverse(tree, features, model.names, model.replacementMin);
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  let met = sum * (model.scale || 1);
  if (model.clip) met = clamp(met, model.clip.min, model.clip.max);
  if (!Number.isFinite(met)) return null;
  return { met, raw: sum * (model.scale || 1) };
}

function valueOf(features, name, replacementMin) {
  if (name == null) return null;
  const v = features[name];
  if (v == null) {
    // null/undefined/NaN all count as missing (do NOT coerce: Number(null)===0).
    // Serve contract: fill with the per-feature TRAINING MINIMUM.
    const r = replacementMin?.[name];
    return Number.isFinite(Number(r)) ? Number(r) : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function traverse(node, features, names, replacementMin) {
  if (node.leaf_value != null && node.left_child == null && node.right_child == null) {
    return node.leaf_value;
  }
  const name = typeof node.split_feature === 'number' && names && names[node.split_feature]
    ? names[node.split_feature]
    : (typeof node.split_feature === 'string' ? node.split_feature : (names ? names[node.split_index] : null));
  const v = valueOf(features, name, replacementMin);
  const threshold = node.threshold;
  let goLeft;
  if (v == null) {
    // No replacement available for this feature: fall back to the node's
    // default_left, the closest derivable routing.
    goLeft = node.default_left === true;
  } else if (typeof node.decision_type === 'string' && node.decision_type.includes('<=')) {
    goLeft = v <= threshold;
  } else {
    goLeft = v < threshold;
  }
  const next = goLeft ? node.left_child : node.right_child;
  if (!next) return 0;
  return traverse(next, features, names, replacementMin);
}
