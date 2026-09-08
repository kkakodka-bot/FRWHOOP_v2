#!/usr/bin/env python3
"""Energy V3 research: nested CV, LOPO, transfer, artifact export.

Does not overwrite energy/v2/artifact/. Writes energy/v3/artifact/.

WEEE / HAbits are development/transfer datasets: results here chose the
architecture and are NOT a pristine external validation set.

Oracle-family MAE is an estimator upper bound (criterion activity known).
It is never reported as end-to-end V3 performance. Runtime-router metrics
are produced by evalRuntime.mjs using the real JS classifier + router.

Run (from whoop/backend):
  python3 energy/v3/research/train_eval.py
"""
from __future__ import annotations

import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.covariance import LedoitWolf
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
ART = HERE.parent / "artifact"
V2_ART = HERE.parent.parent / "v2" / "artifact"
REPO_ROOT = HERE.parents[4]


def _repo_rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)

CORE = [
    "enmo_mean",
    "dyn_enmo_mean",
    "bandpass_motion_auc_20hz",
    "vm_mean",
    "accel_std",
    "enmo_mad",
    "jerk_mean",
    "movement_intermittency",
    "cadence_band_power_frac",
    "periodicity_strength",
]
HR = ["hr_mean", "hrr_frac"]
GYRO = ["gyro_mean_dps", "gyro_energy"]
ORIENT = ["gravity_z_mean", "ax_ay_corr", "tilt_estimate"]

# Runtime router only sends sit/stand to the sedentary ridge; walking is V1.
SED_TRAIN = ("sedentary", "standing")
LOCO_TRAIN = ("running",)  # walking has no defensible shipped model
CYC_TRAIN = ("cycling",)
ADL_ORACLE = ("sedentary", "standing", "daily_activity")
LOCO_ORACLE = ("walking", "running")


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def fnum(row, k):
    try:
        v = float(row[k])
        return v if math.isfinite(v) else None
    except (TypeError, ValueError, KeyError):
        return None


def target_of(row):
    t = fnum(row, "criterion_met")
    if t is None:
        t = fnum(row, "target_met")
    return t


def physical_ok(row):
    """Wrist 60 s means outside this shell are sensor faults, not physiology."""
    vm = fnum(row, "vm_mean")
    dyn = fnum(row, "dyn_enmo_mean")
    if vm is None or vm < 0.7 or vm > 2.5:
        return False
    if dyn is not None and (dyn < 0 or dyn > 5):
        return False
    return True


def xy(rows, keys):
    X, y, keep = [], [], []
    for r in rows:
        if not physical_ok(r):
            continue
        t = target_of(r)
        if t is None or t < 0.5 or t > 20:
            continue
        vec = []
        ok = True
        for k in keys:
            v = fnum(r, k)
            if v is None:
                # old CSVs used mims_mean
                if k == "bandpass_motion_auc_20hz":
                    v = fnum(r, "mims_mean")
                if v is None:
                    ok = False
                    break
            vec.append(v)
        if not ok:
            continue
        X.append(vec)
        y.append(t)
        keep.append(r)
    return np.asarray(X, float), np.asarray(y, float), keep


def metrics(y, yhat, rows=None):
    yhat = np.clip(np.asarray(yhat, float), 0.8, 16.0)
    y = np.asarray(y, float)
    e = yhat - y
    n = int(len(y))
    mae = float(np.mean(np.abs(e))) if n else None
    rmse = float(np.sqrt(np.mean(e ** 2))) if n else None
    bias = float(np.mean(e)) if n else None
    sd = float(np.std(e, ddof=1)) if n > 1 else 0.0
    mape_den = np.abs(y) >= 0.5
    mape = float(np.mean(np.abs(e[mape_den] / y[mape_den])) * 100) if mape_den.any() else None
    se_bias = sd / math.sqrt(n) if n > 1 else None
    se_loa = math.sqrt(3 * sd * sd / n) if n > 1 else None
    loa_lo, loa_hi = (bias - 1.96 * sd, bias + 1.96 * sd) if n else (None, None)
    # Least-products (both axes noisy): slope = sign(sxy) * sy / sx
    lp = None
    if n > 4 and float(np.std(yhat)) > 1e-9:
        sx, sy = float(np.std(yhat, ddof=1)), float(np.std(y, ddof=1))
        sxy = float(np.cov(yhat, y, ddof=1)[0, 1])
        slope = (1 if sxy >= 0 else -1) * (sy / sx)
        intercept = float(np.mean(y) - slope * np.mean(yhat))
        lp = {
            "slope": round(slope, 4),
            "intercept": round(intercept, 4),
            "proportional_bias": abs(slope - 1) > 0.1,
        }
    parts = sorted({(r or {}).get("participant") or "unknown" for r in (rows or [])})
    out = {
        "n": n,
        "n_participants": len(parts),
        "mae": None if mae is None else round(mae, 3),
        "rmse": None if rmse is None else round(rmse, 3),
        "mape": None if mape is None else round(mape, 2),
        "bias": None if bias is None else round(bias, 3),
        "bland_altman": {
            "bias": None if bias is None else round(bias, 3),
            "loa95": None if loa_lo is None else [round(loa_lo, 3), round(loa_hi, 3)],
            "se_bias": None if se_bias is None else round(se_bias, 4),
            "se_loa": None if se_loa is None else round(se_loa, 4),
            "loa95_ci": None if se_loa is None else [
                [round(loa_lo - 1.96 * se_loa, 3), round(loa_lo + 1.96 * se_loa, 3)],
                [round(loa_hi - 1.96 * se_loa, 3), round(loa_hi + 1.96 * se_loa, 3)],
            ],
        },
        "least_products": lp,
        "role": "development_transfer_not_external_validation",
    }
    return out


def by_key(y, yhat, rows, key):
    g = defaultdict(lambda: ([], [], []))
    for yi, yh, r in zip(y, yhat, rows):
        k = r.get(key) or "unknown"
        g[k][0].append(yi)
        g[k][1].append(yh)
        g[k][2].append(r)
    out = {}
    for k, (yy, yh, rr) in sorted(g.items()):
        out[k] = metrics(np.asarray(yy), np.asarray(yh), rr)
    return out


def nested_loso(rows, keys, model_name, make_model):
    parts = sorted({r["participant"] for r in rows})
    y_all, yhat_all, kept = [], [], []
    for held in parts:
        train = [r for r in rows if r["participant"] != held]
        test = [r for r in rows if r["participant"] == held]
        inner_parts = sorted({r["participant"] for r in train})
        if len(inner_parts) < 3:
            continue
        best_mae, best_state = 1e9, None
        for state in candidate_states(model_name):
            pairs = []
            for inner_held in inner_parts:
                tr = [r for r in train if r["participant"] != inner_held]
                te = [r for r in train if r["participant"] == inner_held]
                Xt, yt, _ = xy(tr, keys)
                Xe, ye, _ = xy(te, keys)
                if len(yt) < 8 or len(ye) < 3:
                    continue
                m = make_model(state)
                m.fit(Xt, yt)
                pred = m.predict(Xe)
                pairs.extend(np.abs(pred - ye))
            if not pairs:
                continue
            mae = float(np.mean(pairs))
            if mae < best_mae:
                best_mae, best_state = mae, state
        if best_state is None:
            best_state = candidate_states(model_name)[0]
        Xt, yt, _ = xy(train, keys)
        Xe, ye, ke = xy(test, keys)
        if len(yt) < 8 or len(ye) < 1:
            continue
        m = make_model(best_state)
        m.fit(Xt, yt)
        pred = m.predict(Xe)
        y_all.extend(ye)
        yhat_all.extend(pred)
        kept.extend(ke)
    y_all, yhat_all = np.asarray(y_all), np.asarray(yhat_all)
    if not len(y_all):
        return {"name": model_name, "n": 0}
    out = metrics(y_all, yhat_all, kept)
    out.update({
        "name": model_name,
        "keys": keys,
        "nested": True,
        "eval_kind": "oracle_family",
        "per_subject": by_key(y_all, yhat_all, kept, "participant"),
        "per_activity": by_key(y_all, yhat_all, kept, "activity"),
    })
    return out


def lopo(rows, keys, model_name, make_model, state=None):
    state = state or candidate_states(model_name)[0]
    parts = sorted({r["participant"] for r in rows})
    y_all, yhat_all, kept = [], [], []
    for held in parts:
        train = [r for r in rows if r["participant"] != held]
        test = [r for r in rows if r["participant"] == held]
        Xt, yt, _ = xy(train, keys)
        Xe, ye, ke = xy(test, keys)
        if len(yt) < 8 or len(ye) < 1:
            continue
        m = make_model(state)
        m.fit(Xt, yt)
        pred = m.predict(Xe)
        y_all.extend(ye)
        yhat_all.extend(pred)
        kept.extend(ke)
    y_all, yhat_all = np.asarray(y_all), np.asarray(yhat_all)
    if not len(y_all):
        return {"name": model_name, "n": 0}
    out = metrics(y_all, yhat_all, kept)
    out.update({
        "name": model_name,
        "keys": keys,
        "lopo": True,
        "eval_kind": "oracle_family",
        "per_subject": by_key(y_all, yhat_all, kept, "participant"),
        "per_activity": by_key(y_all, yhat_all, kept, "activity"),
    })
    return out


def lopo_row_preds(rows, keys, family, make_model, state=None):
    state = state or {"alpha": 0.1}
    parts = sorted({r["participant"] for r in rows})
    out = []
    for held in parts:
        train = [r for r in rows if r["participant"] != held]
        test = [r for r in rows if r["participant"] == held]
        Xt, yt, _ = xy(train, keys)
        Xe, ye, ke = xy(test, keys)
        if len(yt) < 8 or len(ye) < 1:
            continue
        m = make_model(state)
        m.fit(Xt, yt)
        pred = np.clip(m.predict(Xe), 0.8, 16.0)
        for r, y, yh in zip(ke, ye, pred):
            out.append({
                "dataset": r.get("dataset"),
                "participant": r.get("participant"),
                "minute_iso": r.get("minute_iso"),
                "activity": r.get("activity"),
                "activity_family": r.get("activity_family"),
                "oracle_family": family,
                "y": float(y),
                "oracle_pred": float(yh),
                "steady_state": r.get("steady_state") or "0",
            })
    return out


def candidate_states(name):
    if name.startswith("ridge"):
        return [{"alpha": a} for a in (0.001, 0.01, 0.1, 1.0)]
    if name.startswith("rf"):
        return [{"n_estimators": 80, "max_depth": d, "random_state": 0, "min_samples_leaf": 5} for d in (4, 6)]
    if name.startswith("gb"):
        return [{"n_estimators": 80, "max_depth": 2, "learning_rate": 0.08, "random_state": 0}]
    return [{}]


def make_ridge(state):
    return Pipeline([("sc", StandardScaler()), ("m", Ridge(alpha=state["alpha"]))])


def make_rf(state):
    return RandomForestRegressor(**state)


def make_gb(state):
    return GradientBoostingRegressor(**state)


def transfer(train_rows, test_rows, keys, make_model, state, name):
    Xt, yt, _ = xy(train_rows, keys)
    Xe, ye, ke = xy(test_rows, keys)
    if len(yt) < 8 or len(ye) < 8:
        return {"name": name, "n": 0, "error": "too_few", "eval_kind": "oracle_family"}
    m = make_model(state)
    m.fit(Xt, yt)
    pred = m.predict(Xe)
    out = metrics(ye, pred, ke)
    out.update({
        "name": name,
        "keys": keys,
        "eval_kind": "oracle_family",
        "per_subject": by_key(ye, pred, ke, "participant"),
        "per_activity": by_key(ye, pred, ke, "activity"),
    })
    return out


def two_stage_fit_predict(train, test, keys):
    """Sedentary classifier + ridge; held-out participant is absent from both."""
    Xt, yt, keep_tr = xy(train, keys)
    Xe, ye, ke = xy(test, keys)
    if len(yt) < 8 or len(ye) < 1:
        return None
    yclf_k = np.array([1.0 if r.get("activity_family") in SED_TRAIN else 0.0 for r in keep_tr])
    if len(set(yclf_k.tolist())) < 2:
        return None
    clf = Pipeline([("sc", StandardScaler()), ("m", LogisticRegression(max_iter=200))])
    clf.fit(Xt, yclf_k)
    sed_rows = [r for r in keep_tr if r.get("activity_family") in SED_TRAIN]
    act_rows = [r for r in keep_tr if r.get("activity_family") not in SED_TRAIN]
    Xs, ys, _ = xy(sed_rows, keys)
    Xa, ya, _ = xy(act_rows, keys)
    if len(ys) < 5 or len(ya) < 5:
        return None
    rs = make_ridge({"alpha": 0.1})
    ra = make_ridge({"alpha": 0.1})
    rs.fit(Xs, ys)
    ra.fit(Xa, ya)
    p_sed = clf.predict_proba(Xe)[:, 1]
    pred = np.where(p_sed >= 0.5, rs.predict(Xe), ra.predict(Xe))
    return ye, pred, ke


def ridge_artifact(rows, keys, clip):
    X, y, _ = xy(rows, keys)
    if len(y) < 8:
        return None
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-8] = 1.0
    Z = (X - mean) / std
    m = Ridge(alpha=0.1, fit_intercept=True)
    m.fit(Z, y)
    return {
        "kind": "ridge",
        "features": list(keys),
        "coef": [float(c) for c in m.coef_],
        "intercept": float(m.intercept_),
        "standardize": {
            "mean": {k: float(mean[i]) for i, k in enumerate(keys)},
            "std": {k: float(std[i]) for i, k in enumerate(keys)},
        },
        "clip": clip,
        "n": int(len(y)),
    }


def _mahal(X, location, precision):
    d = X - location
    return np.sqrt(np.maximum(0.0, np.einsum("ij,ji->i", d @ precision, d.T)))


def domain_stats(rows, keys, reference_dataset):
    """Train-only center/scale; LOPO held-out distances set the threshold.

    WHOOP is never used to choose the threshold.
    """
    X, _, _ = xy(rows, keys)
    if len(X) < 10:
        return {}
    median = np.median(X, axis=0)
    mad = np.median(np.abs(X - median), axis=0)
    p01 = np.percentile(X, 1, axis=0)
    p99 = np.percentile(X, 99, axis=0)
    p = X.shape[1]
    use_lw = len(X) >= 3 * p
    distance_kind = "ledoit_wolf"
    mean = X.mean(axis=0)
    cov_inv = np.eye(p)
    mahal_method = "ledoit_wolf"
    if use_lw:
        try:
            with np.errstate(all="ignore"):
                lw = LedoitWolf().fit(X)
                cond = float(np.linalg.cond(lw.covariance_))
                prec = lw.precision_
            if (not np.isfinite(cond)) or cond > 1e10 or (not np.isfinite(prec).all()):
                use_lw = False
            else:
                mean = lw.location_
                cov_inv = prec
        except Exception:
            use_lw = False
    if not use_lw:
        distance_kind = "diagonal_robust_z"
        mahal_method = "diagonal_robust_z"
        cov_inv = np.diag(1.0 / np.maximum((1.4826 * mad) ** 2, 1e-12))

    held_d = []
    parts = sorted({r["participant"] for r in rows})
    for held in parts:
        train = [r for r in rows if r["participant"] != held]
        test = [r for r in rows if r["participant"] == held]
        Xt, _, _ = xy(train, keys)
        Xe, _, _ = xy(test, keys)
        if len(Xt) < 10 or len(Xe) < 1:
            continue
        if distance_kind == "ledoit_wolf":
            try:
                with np.errstate(all="ignore"):
                    lw = LedoitWolf().fit(Xt)
                    d = _mahal(Xe, lw.location_, lw.precision_)
                if np.isfinite(d).all():
                    held_d.extend(d.tolist())
            except Exception:
                continue
        else:
            med = np.median(Xt, axis=0)
            md = np.median(np.abs(Xt - med), axis=0)
            scale = np.maximum(1.4826 * md, 1e-9)
            held_d.extend(np.max(np.abs(Xe - med) / scale, axis=1).tolist())
    if len(held_d) >= 8:
        threshold = float(np.percentile(held_d, 95))
        threshold_source = "lopo_heldout_p95"
    else:
        threshold = 8.0 if distance_kind == "diagonal_robust_z" else 6.0
        threshold_source = "default_underpowered"
    return {
        "features": list(keys),
        "median": {k: float(median[i]) for i, k in enumerate(keys)},
        "mad": {k: float(mad[i]) for i, k in enumerate(keys)},
        "p01": {k: float(p01[i]) for i, k in enumerate(keys)},
        "p99": {k: float(p99[i]) for i, k in enumerate(keys)},
        "mean": {k: float(mean[i]) for i, k in enumerate(keys)},
        "cov_inv": cov_inv.tolist(),
        "mahal_features": list(keys),
        "mahal_limit": threshold,
        "k_mad": 8.0,
        "distance_kind": distance_kind,
        "mahal_method": mahal_method,
        "threshold_source": threshold_source,
        "reference_dataset": reference_dataset,
        "reference_version": "energy-v3.1.1-unvalidated",
        "whoop_used_for_threshold": False,
        "n_heldout_distances": len(held_d),
        "safety_gate_not_accuracy_probability": True,
    }


def research_residual_band(rows, keys, q=0.9):
    """LOPO |residual| quantile. Not split-conformal for the all-data artifact."""
    parts = sorted({r["participant"] for r in rows})
    if len(parts) < 4:
        return None
    resid = []
    for held in parts:
        train = [r for r in rows if r["participant"] != held]
        test = [r for r in rows if r["participant"] == held]
        Xt, yt, _ = xy(train, keys)
        Xc, yc, _ = xy(test, keys)
        if len(yt) < 8 or len(yc) < 1:
            continue
        m = make_ridge({"alpha": 0.1})
        m.fit(Xt, yt)
        resid.extend(np.abs(m.predict(Xc) - yc).tolist())
    if len(resid) < 5:
        return None
    return {
        "kind": "research_residual_band",
        "split_conformal": False,
        "q": float(np.quantile(resid, q)),
        "level": q,
        "n": int(len(resid)),
        "note": (
            "Population artifact is refit on all public participants; these "
            "quantiles are LOPO residual bands, not valid split-conformal "
            "coverage for the shipped model. WHOOP criterion interval unavailable."
        ),
    }


def leakage_sentinel():
    """Inject a held-out-only statistic; fitted objects must not observe it."""
    MAGIC = 424242.4242
    TOKEN = "HELD_OUT_TOKEN_P99"
    keys = list(CORE)
    rows = []
    for i, pid in enumerate(["P01", "P02", "P03", "P99"]):
        for j in range(24):
            r = {k: float(0.05 * i + 0.01 * j + 0.02 * ki) for ki, k in enumerate(keys)}
            r["participant"] = pid
            r["criterion_met"] = 1.2 + 0.01 * j
            r["activity_family"] = "sedentary"
            r["vm_mean"] = 1.0
            r["dyn_enmo_mean"] = 0.05
            r["enmo_mean"] = 0.04 + 0.001 * j
            if pid == "P99":
                r["enmo_mean"] = MAGIC
                r["leak_token"] = TOKEN
            rows.append(r)
    train = [r for r in rows if r["participant"] != "P99"]
    Xt, yt, _ = xy(train, keys)
    pipe = make_ridge({"alpha": 0.1})
    pipe.fit(Xt, yt)
    dumped = json.dumps({
        "mean": pipe.named_steps["sc"].mean_.tolist(),
        "scale": pipe.named_steps["sc"].scale_.tolist(),
        "coef": pipe.named_steps["m"].coef_.tolist(),
    })
    if TOKEN in dumped or MAGIC in pipe.named_steps["sc"].mean_:
        raise SystemExit("leakage_sentinel_failed: held-out token in fitted object")
    Xall, yall, _ = xy(rows, keys)
    pipe2 = make_ridge({"alpha": 0.1})
    pipe2.fit(Xall, yall)
    if abs(float(pipe2.named_steps["sc"].mean_[0]) - float(pipe.named_steps["sc"].mean_[0])) < 1e-12:
        raise SystemExit("leakage_sentinel_positive_control_failed")
    # Classifier path
    yclf = np.array([1.0 if r["participant"] != "P99" else 0.0 for r in train])
    clf = Pipeline([("sc", StandardScaler()), ("m", LogisticRegression(max_iter=200))])
    # train has no P99, so this is the disjoint case
    yclf = np.array([1.0 if (j % 2 == 0) else 0.0 for j, _ in enumerate(train)])
    clf.fit(Xt, yclf)
    cd = json.dumps(clf.named_steps["sc"].mean_.tolist())
    if TOKEN in cd or MAGIC in clf.named_steps["sc"].mean_:
        raise SystemExit("leakage_sentinel_failed: classifier saw held-out token")
    return {
        "ok": True,
        "train_enmo_mean": float(pipe.named_steps["sc"].mean_[0]),
        "all_enmo_mean": float(pipe2.named_steps["sc"].mean_[0]),
    }


def fam(rows, names):
    return [r for r in rows if r.get("activity_family") in names]


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


RF_STATE = {"n_estimators": 80, "max_depth": 4, "random_state": 0, "min_samples_leaf": 5}


def main():
    sentinel = leakage_sentinel()
    weee_all = read_csv(CACHE / "minutes_weee.csv")
    habits_all = read_csv(CACHE / "minutes_habits.csv")
    weee = [r for r in weee_all if physical_ok(r)]
    habits = [
        r for r in habits_all
        if r.get("activity_family") != "strength" and physical_ok(r)
    ]
    weee_sed, weee_run, weee_cyc = fam(weee, SED_TRAIN), fam(weee, LOCO_TRAIN), fam(weee, CYC_TRAIN)
    weee_adl_oracle, weee_loco_oracle = fam(weee, ADL_ORACLE), fam(weee, LOCO_ORACLE)
    habits_sed, habits_run = fam(habits, SED_TRAIN), fam(habits, LOCO_TRAIN)
    habits_adl_oracle, habits_loco_oracle = fam(habits, ADL_ORACLE), fam(habits, LOCO_ORACLE)

    target_manifest = {
        "criterion_vo2_ml_kg_min": "WEEE DataAverage VO2[mL/kg/min]; HAbits MetCart 60s VO2/kg column",
        "criterion_met": "criterion_vo2_ml_kg_min / 3.5",
        "pooled": True,
        "pool_reason": "both datasets are oxygen MET (VO2 ml/kg/min / 3.5); HAbits printer METS is rounded VO2/kg/3.5, not Weir",
        "not_used": [
            "Ainsworth", "Google Fit", "public in-lab.py clamp-below-1.0",
            "Weir VCO2 formula", "5 kcal/L O2 as a training target",
        ],
        "production_kcal_convention": {
            "kcal_per_litre_o2": 5.0,
            "role": "production conversion approximation after MET; not mixed into the training target",
        },
        "sync": {
            "weee": "VO2 DataAverage absolute Time aligned to E4 ACC unix after UTC+8 site offset; 60 s bins from segment start",
            "habits": "MetCart 60s clock in America/Chicago vs acc_resample Time; first 2 activity minutes dropped as warmup (protocol, not residual)",
        },
    }

    report = {
        "split": {
            "weee": "nested leave-one-participant-out; inner ridge λ grid. RF/GB hyperparameters frozen a priori.",
            "habits": "leave-one-participant-out; held-out absent from classifier, scaler, regression, OOD, residual band",
            "transfer": "scored once on frozen common accel subset and activity family; not used to retune",
            "physical_filter": "vm_mean in [0.7, 2.5] g and dyn_enmo_mean in [0, 5] (sensor-fault minutes dropped; not residual-based)",
            "eval_kinds": {
                "oracle_family": "criterion activity selects the family; estimator upper bound only",
                "runtime_router": "see evalRuntime.mjs; real V3 router; never report oracle MAE as E2E V3",
            },
            "dataset_role": "development_transfer_not_external_validation",
        },
        "target": target_manifest,
        "leakage_sentinel": sentinel,
        "weee_n": len(weee),
        "habits_n": len(habits),
        "refused_labels": ["Apple", "WHOOP", "Fitbit", "GoogleFit", "Ainsworth", "Freedson", "VM3", "in-wild"],
        "mims_verdict": {
            "feature": "bandpass_motion_auc_20hz",
            "is_nhanes_mims": False,
            "reason": "1-pole 0.2–5 Hz at 20 Hz; no 100 Hz cubic spline, no 4th-order Butterworth, no per-axis integrated MIMS, no monitor-independence claim",
        },
        "results": {},
        "rejected": [],
        "selected": {},
    }

    if weee:
        ss = [r for r in weee if str(r.get("steady_state")) in ("1", "1.0")]
        report["results"]["weee_nested"] = {
            "ridge_core": nested_loso(weee, CORE, "ridge_core", make_ridge),
            "ridge_core_hr": nested_loso(weee, CORE + HR, "ridge_core_hr", make_ridge),
            "ridge_orient": nested_loso(weee, CORE + ORIENT, "ridge_orient", make_ridge),
            "rf_core_hr": lopo(weee, CORE + HR, "rf_core_hr", make_rf),
            "gb_core_hr": lopo(weee, CORE + HR, "gb_core_hr", make_gb),
            "ridge_sed_sit_stand": nested_loso(weee_sed, CORE, "ridge_sed", make_ridge),
            "ridge_adl_oracle": nested_loso(weee_adl_oracle, CORE, "ridge_adl_oracle", make_ridge),
            "ridge_run_hr": nested_loso(weee_run, CORE + HR, "ridge_run_hr", make_ridge),
            "ridge_loco_oracle": nested_loso(weee_loco_oracle, CORE + HR, "ridge_loco_oracle", make_ridge),
            "ridge_cycling_hr": nested_loso(weee_cyc, HR + CORE, "ridge_cycling_hr", make_ridge),
        }
        if ss:
            report["results"]["weee_nested"]["steady_state_last3_exercise"] = nested_loso(
                ss, CORE + HR, "ridge_core_hr_steady", make_ridge,
            )
        y_all, yhat_all, kept = [], [], []
        parts = sorted({r["participant"] for r in weee})
        for held in parts:
            got = two_stage_fit_predict(
                [r for r in weee if r["participant"] != held],
                [r for r in weee if r["participant"] == held],
                CORE + HR,
            )
            if not got:
                continue
            ye, pred, ke = got
            y_all.extend(ye)
            yhat_all.extend(pred)
            kept.extend(ke)
        if y_all:
            ya, yh = np.asarray(y_all), np.asarray(yhat_all)
            ts = metrics(ya, yh, kept)
            ts.update({"name": "two_stage_core_hr", "eval_kind": "oracle_family", "per_activity": by_key(ya, yh, kept, "activity")})
            report["results"]["weee_nested"]["two_stage_core_hr"] = ts

    if habits:
        gyro_sed = [r for r in habits_sed if fnum(r, "gyro_mean_dps") is not None]
        report["results"]["habits_lopo"] = {
            "ridge_core": lopo(habits, CORE, "ridge_core", make_ridge),
            "rf_core": lopo(habits, CORE, "rf_core", make_rf),
            "ridge_sed_sit_stand": lopo(habits_sed, CORE, "ridge_sed", make_ridge),
            "ridge_adl_oracle": lopo(habits_adl_oracle, CORE, "ridge_adl_oracle", make_ridge),
            "rf_adl_oracle": lopo(habits_adl_oracle, CORE, "rf_adl_oracle", make_rf),
            "ridge_loco_oracle": lopo(habits_loco_oracle, CORE, "ridge_loco_oracle", make_ridge),
            "habits_reference_corrected_two_stage": None,
        }
        y_all, yhat_all, kept = [], [], []
        parts = sorted({r["participant"] for r in habits})
        for held in parts:
            got = two_stage_fit_predict(
                [r for r in habits if r["participant"] != held],
                [r for r in habits if r["participant"] == held],
                CORE,
            )
            if not got:
                continue
            ye, pred, ke = got
            y_all.extend(ye)
            yhat_all.extend(pred)
            kept.extend(ke)
        if y_all:
            ya, yh = np.asarray(y_all), np.asarray(yhat_all)
            ts = metrics(ya, yh, kept)
            ts.update({
                "name": "habits_reference_corrected_two_stage",
                "eval_kind": "oracle_family",
                "note": "Participant-disjoint classifier+ridge. Does not copy public in-lab.py concatenate leak.",
                "per_activity": by_key(ya, yh, kept, "activity"),
            })
            report["results"]["habits_lopo"]["habits_reference_corrected_two_stage"] = ts
        if gyro_sed:
            report["results"]["habits_lopo"]["ridge_sed_gyro"] = lopo(gyro_sed, CORE + GYRO, "ridge_sed_gyro", make_ridge)

    common = CORE
    if weee and habits:
        report["results"]["transfer"] = {
            "weee_to_habits_ridge_core": transfer(weee, habits, common, make_ridge, {"alpha": 0.1}, "weee→habits"),
            "habits_to_weee_ridge_core": transfer(habits, weee, common, make_ridge, {"alpha": 0.1}, "habits→weee"),
            "weee_to_habits_ridge_sed": transfer(weee_sed, habits_sed, common, make_ridge, {"alpha": 0.1}, "weee→habits sed"),
            "habits_to_weee_ridge_sed": transfer(habits_sed, weee_sed, common, make_ridge, {"alpha": 0.1}, "habits→weee sed"),
            "weee_to_habits_ridge_adl_oracle": transfer(weee_adl_oracle, habits_adl_oracle, common, make_ridge, {"alpha": 0.1}, "weee→habits adl oracle"),
            "habits_to_weee_ridge_adl_oracle": transfer(habits_adl_oracle, weee_adl_oracle, common, make_ridge, {"alpha": 0.1}, "habits→weee adl oracle"),
            "weee_to_habits_rf_adl_oracle": transfer(weee_adl_oracle, habits_adl_oracle, common, make_rf, RF_STATE, "weee→habits rf adl"),
            "weee_to_habits_orient": transfer(weee, habits, CORE + ORIENT, make_ridge, {"alpha": 0.1}, "weee→habits orient"),
            "weee_to_habits_ridge_loco_oracle": transfer(weee_loco_oracle, habits_loco_oracle, common, make_ridge, {"alpha": 0.1}, "weee→habits loco oracle"),
            "habits_to_weee_ridge_loco_oracle": transfer(habits_loco_oracle, weee_loco_oracle, common, make_ridge, {"alpha": 0.1}, "habits→weee loco oracle"),
        }
        t = report["results"]["transfer"]
        adl_ridge = t["weee_to_habits_ridge_adl_oracle"].get("mae") or 9
        adl_rf = t["weee_to_habits_rf_adl_oracle"].get("mae") or 9
        orient_mae = t["weee_to_habits_orient"].get("mae") or 9
        pooled_ridge = t["weee_to_habits_ridge_core"].get("mae") or 9
        report["rejected"].append({
            "features": ORIENT,
            "reason": "orientation features isolated: device axes are not a common frame",
            "core_mae": pooled_ridge,
            "orient_mae": orient_mae,
        })
        report["rejected"].append({
            "model": "random_forest",
            "reason": "RF is slightly better on ADL transfer but not decisive; runtime stays family ridge",
            "ridge_adl_transfer_mae": adl_ridge,
            "rf_adl_transfer_mae": adl_rf,
        })
        report["rejected"].append({
            "model": "neural_temporal",
            "reason": "not trained: ridge/RF already compared; neural only allowed if both held-out AND transfer improve",
        })
        report["rejected"].append({
            "family": "walking",
            "reason": "no defensible walking model; runtime router falls back to V1",
        })
        report["rejected"].append({
            "family": "daily_activity",
            "reason": "not independently validated for the learned ADL ridge; runtime V1",
        })

    sed = habits_sed + weee_sed
    models = {}
    if sed:
        models["imu_sedentary"] = ridge_artifact(sed, CORE, {"min": 0.8, "max": 6.0})
    if weee_run:
        models["hr_imu_locomotion"] = ridge_artifact(weee_run, CORE + HR, {"min": 1.8, "max": 16.0})
    if weee_cyc:
        models["hr_cycling"] = ridge_artifact(weee_cyc, HR + CORE, {"min": 2.5, "max": 16.0})

    gyro_models = {}
    habits_gyro = [r for r in habits_sed if fnum(r, "gyro_mean_dps") is not None]
    if habits_gyro:
        gyro_models["imu_sedentary"] = ridge_artifact(habits_gyro, CORE + GYRO, {"min": 0.8, "max": 6.0})

    domain = {
        "imu_sedentary": domain_stats(sed, CORE, "weee_sit_stand+habits_sed_stand"),
        "hr_imu_locomotion": domain_stats(weee_run, CORE, "weee_running"),
        "hr_cycling": domain_stats(weee_cyc, CORE, "weee_cycling"),
        "pooled": domain_stats(weee + habits, CORE, "weee+habits_public"),
    }
    gyro_domain = domain_stats(
        [r for r in (weee + habits) if fnum(r, "gyro_mean_dps") is not None],
        CORE + GYRO,
        "habits_sed_gyro",
    )

    pred_rows = []
    pred_rows += lopo_row_preds(sed, CORE, "imu_sedentary", make_ridge)
    pred_rows += lopo_row_preds(weee_run, CORE + HR, "hr_imu_locomotion", make_ridge)
    pred_rows += lopo_row_preds(weee_cyc, HR + CORE, "hr_cycling", make_ridge)
    pred_rows += lopo_row_preds(habits_loco_oracle, CORE, "hr_imu_locomotion_oracle_no_hr", make_ridge)
    write_csv(CACHE / "lopo_family_preds.csv", pred_rows)

    ART.mkdir(parents=True, exist_ok=True)
    artifact = {
        "artifact_version": "energy-v3-ridge-1",
        "feature_version": "feat-v3-2",
        "model_version": "energy-v3.1.1-unvalidated",
        "trained_on": ["weee_vo2_met", "habits_metcart_vo2_over_3.5"],
        "not_trained_on": ["v2_lgb_artifact", "apple", "whoop_calories", "ainsworth", "weir"],
        "target": target_manifest,
        "models": {k: v for k, v in models.items() if v},
        "gyro_models": {k: v for k, v in gyro_models.items() if v},
        "domain": domain,
        "gyro_domain": gyro_domain,
        "uncertainty": {
            "kind": "research_residual_band",
            "split_conformal": False,
            "criterion_calibrated_whoop": False,
            "reason": "population artifact is refit on all public participants; no untouched calibration cohort remains",
            "public_residual_bands": {
                "adl": research_residual_band(sed, CORE),
                "loco": research_residual_band(weee_run, CORE + HR),
                "cycling": research_residual_band(weee_cyc, HR + CORE),
            },
            "whoop_exposure": "criterion_uncertainty: unavailable",
        },
        "rejected_features": report["rejected"],
        "v2_untouched": _repo_rel(V2_ART / "energy-v2-lgb-runtime.json"),
        "mims_verdict": report["mims_verdict"],
    }
    (ART / "energy-v3-runtime.json").write_text(json.dumps(artifact, indent=2) + "\n")
    report["selected"] = {
        "runtime": "ridge per activity family; walking and daily_activity are V1 at runtime",
        "families": list(artifact["models"]),
        "gyro_optional_families": list(artifact["gyro_models"]),
        "artifact": _repo_rel(ART / "energy-v3-runtime.json"),
        "eval_kind_warning": "oracle_family numbers below are NOT end-to-end V3",
    }
    (ART / "training-manifest.json").write_text(json.dumps({
        "weee_n": len(weee),
        "habits_n": len(habits),
        "features_core": CORE,
        "features_hr": HR,
        "features_gyro": GYRO,
        "label_weee": "criterion_vo2_ml_kg_min / 3.5",
        "label_habits": "criterion_vo2_ml_kg_min / 3.5 from MetCart 60s VO2/kg",
        "target": target_manifest,
        "script": "energy/v3/research/train_eval.py",
        "does_not_modify": "energy/v2/artifact/",
        "physical_filter": "vm_mean [0.7, 2.5], dyn_enmo [0, 5]",
        "mims": "renamed to bandpass_motion_auc_20hz; not NHANES MIMS",
        "conformal": "research_residual_band; not split-conformal for shipped all-data fit",
        "dataset_role": "development_transfer_not_external_validation",
        "leakage_sentinel": sentinel,
    }, indent=2) + "\n")
    (CACHE / "eval_report.json").write_text(json.dumps(report, indent=2) + "\n")

    def compact(d):
        if not isinstance(d, dict):
            return d
        out = {k: d[k] for k in ("n", "n_participants", "mae", "rmse", "mape", "bias", "name", "eval_kind") if k in d}
        if "bland_altman" in d:
            out["loa95"] = d["bland_altman"].get("loa95")
        if "least_products" in d:
            out["least_products"] = d["least_products"]
        if "per_activity" in d:
            out["per_activity"] = {k: compact(v) for k, v in d["per_activity"].items()}
        if "per_subject" in d:
            out["per_subject"] = {k: {"n": v.get("n"), "mae": v.get("mae"), "bias": v.get("bias")} for k, v in d["per_subject"].items()}
        return out

    summary = {
        "weee_n": len(weee),
        "habits_n": len(habits),
        "eval_kind_warning": "oracle_family is not end-to-end V3; runtime_router is evalRuntime.mjs",
        "dataset_role": "development_transfer_not_external_validation",
        "weee_nested": {k: compact(v) for k, v in (report["results"].get("weee_nested") or {}).items()},
        "habits_lopo": {k: compact(v) for k, v in (report["results"].get("habits_lopo") or {}).items()},
        "transfer": {k: compact(v) for k, v in (report["results"].get("transfer") or {}).items()},
        "rejected": report["rejected"],
        "selected": report["selected"],
        "leakage_sentinel": sentinel,
        "mims_verdict": report["mims_verdict"],
        "target": target_manifest,
    }
    (ART / "eval-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({
        "wrote": str(ART / "energy-v3-runtime.json"),
        "weee": len(weee),
        "habits": len(habits),
        "models": list(artifact["models"]),
        "lopo_preds": len(pred_rows),
        "leakage_sentinel": sentinel["ok"],
    }, indent=2))


if __name__ == "__main__":
    main()
