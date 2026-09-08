#!/usr/bin/env python3
"""Build HAbits in-lab minute index: MetCart labels + activity windows.

Never writes Apple/Fitbit/Google-Fit/Ainsworth/Freedson/VM3 as targets.
"""
from __future__ import annotations

import csv
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3] / "data" / "habits" / "inlab"
OUT = Path(__file__).resolve().parent / "cache" / "habits_index.csv"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
CHI = ZoneInfo("America/Chicago")

FAMILY = {
    "Rest": "sedentary",
    "Typing on a computer while seated": "sedentary",
    "Reading a book or magazine while reclining": "sedentary",
    "Lying down while doing nothing": "sedentary",
    "Standing while fidgeting": "daily_activity",
    "Sweeping slowly": "daily_activity",
    "Sweeping slowly ": "daily_activity",
    "Walking 2 mph on treadmill": "walking",
    "Walking 3.5 mph on treadmill": "walking",
    "Running 4 mph on a treadmill": "running",
    "Squats (shoulder length legs, get down to 90 degree angle)": "strength",
    "Push-ups against the wall": "strength",
    "General aerobics video": "daily_activity",
    "Chester Step Test (0.25 m step at a rate of 30 steps per minute)": "walking",
}


def xlsx_rows(path: Path):
    with zipfile.ZipFile(path) as z:
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            ss = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in ss.findall("m:si", NS):
                strings.append("".join(t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        out = []
        for row in sheet.findall("m:sheetData/m:row", NS):
            vals = []
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                if v is None:
                    vals.append("")
                    continue
                if c.attrib.get("t") == "s":
                    vals.append(strings[int(v.text)])
                else:
                    vals.append(v.text or "")
            out.append(vals)
        return out


def excel_time_to_hms(frac):
    sec = int(round(float(frac) * 86400)) % 86400
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return h, m, s


def parse_mdy(text):
    m = re.search(r"Date:\s*(\d{1,2})/(\d{1,2})/(\d{2,4})", str(text))
    if not m:
        return None
    mm, dd, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yy < 100:
        yy += 2000
    return yy, mm, dd


def parse_log_date(rows):
    for row in rows:
        for cell in row:
            dated = parse_mdy(cell)
            if dated:
                return dated
    return None


def parse_metcart_date(path: Path):
    # Activity logs sometimes omit Date:; MetCart headers still have it.
    text = path.read_text(errors="replace")[:4000]
    return parse_mdy(text)


def parse_metcart_60(path: Path, y, mo, d):
    """60-s cart rows: METS is rounded VO2/kg/3.5. Also keep VO2/kg.

    Line shape (concatenated clocks, then whitespace numbers):
      HH:MM:SSHH:MM:SS  METS  VO2_L/min  VO2/kg  VCO2  RQ  VE  VEOT2
    METS ≈ round(VO2/kg / 3.5, 1). Not Weir (VCO2 is unused).
    """
    text = path.read_text(errors="replace")
    out = []
    for line in text.splitlines():
        m = re.match(
            r"^(\d{2}):(\d{2}):(\d{2})(\d{2}):(\d{2}):(\d{2})\s+(.*)$",
            line.strip(),
        )
        if not m:
            continue
        rest = m.group(7).split()
        if len(rest) < 3:
            continue
        try:
            mets = float(rest[0])
            vo2_l = float(rest[1])
            vo2_kg = float(rest[2])
        except ValueError:
            continue
        hh, mi, ss = int(m.group(1)), int(m.group(2)), int(m.group(3))
        dt = datetime(y, mo, d, hh, mi, ss, tzinfo=CHI)
        out.append({
            "ts_ms": dt.timestamp() * 1000,
            "cart_mets_rounded": mets,
            "vo2_l_min": vo2_l,
            "vo2_ml_kg_min": vo2_kg,
            "criterion_met": vo2_kg / 3.5,
        })
    return out


def find_metcart(pdir: Path):
    """Prefer a true 60-s report. P1014's '60 sec' file is raw-sized; use actual."""
    folder = pdir / "Metcart"
    if not folder.exists():
        return None
    cands = [
        f for f in folder.iterdir()
        if f.is_file() and "raw" not in f.name.lower() and "60" in f.name.lower()
    ]
    if not cands:
        return None
    actual = [f for f in cands if "actual" in f.name.lower()]
    pool = actual or cands
    return min(pool, key=lambda f: f.stat().st_size)


def acc_resample_path(pdir: Path) -> Path:
    return pdir / "Wrist Data/Clean/Resampled/Accelerometer/acc_resample.csv"


def release_gap_reason(pdir: Path, met_path: Path | None, cart: list) -> str | None:
    pid = pdir.name
    has_acc = acc_resample_path(pdir).exists()
    if pid in ("P1007", "P1011") and (met_path is None or not cart):
        return "release_missing_60s_metcart"
    if pid in ("P1009", "P1014") and not has_acc:
        return "release_missing_acc_resample"
    if not has_acc:
        return "release_missing_acc_resample"
    if met_path is None or not cart:
        return "release_missing_60s_metcart"
    return None


def main():
    rows_out = []
    ledger = []
    inventory = []
    for pdir in sorted(ROOT.glob("P10*")):
        pid = pdir.name
        log = next(pdir.glob("*Activity Log.xlsx"), None)
        met_path = find_metcart(pdir)
        table = xlsx_rows(log) if log else []
        dated = (parse_log_date(table) if table else None) or (
            parse_metcart_date(met_path) if met_path else None
        )
        cart = parse_metcart_60(met_path, *dated) if (met_path and dated) else []
        gap = release_gap_reason(pdir, met_path, cart)
        inventory.append({
            "participant": pid,
            "has_activity_log": bool(log),
            "has_metcart_dir": (pdir / "Metcart").exists(),
            "metcart_60s_file": str(met_path) if met_path else None,
            "metcart_60s_rows": len(cart),
            "has_acc_resample": acc_resample_path(pdir).exists(),
            "release_gap": gap,
        })
        if gap in ("release_missing_60s_metcart", "release_missing_acc_resample"):
            ledger.append({
                "dataset": "habits",
                "participant": pid,
                "activity": "*",
                "candidate_minutes": 0,
                "included_minutes": 0,
                "excluded_minutes": 0,
                "exclusion_reason": gap,
            })
        if not log or not dated or not cart:
            continue
        y, mo, d = dated
        header_i = next((i for i, r in enumerate(table) if any("Start Time" in str(c) for c in r)), None)
        if header_i is None:
            continue
        header = table[header_i]
        def idx(name):
            for i, h in enumerate(header):
                if name.lower() in str(h).lower():
                    return i
            return None
        i_start = idx("Start Time")
        i_stop = idx("Expected Stop Time")
        i_inc = idx("Include")
        for r in table[header_i + 1:]:
            if not r or not r[0] or str(r[0]).startswith("Participant"):
                continue
            activity = str(r[0]).strip()
            if i_inc is not None and i_inc < len(r) and str(r[i_inc]).strip() not in ("1", "1.0"):
                ledger.append({
                    "dataset": "habits",
                    "participant": pid,
                    "activity": activity,
                    "candidate_minutes": 0,
                    "included_minutes": 0,
                    "excluded_minutes": 0,
                    "exclusion_reason": "activity_log_include_not_1",
                })
                continue
            try:
                sh, sm, ss = excel_time_to_hms(r[i_start])
                eh, em, es = excel_time_to_hms(r[i_stop])
            except (TypeError, ValueError, IndexError):
                continue
            start = datetime(y, mo, d, sh, sm, ss, tzinfo=CHI)
            end = datetime(y, mo, d, eh, em, es, tzinfo=CHI)
            if end <= start:
                continue
            protocol_min = int((end - start).total_seconds() // 60)
            skipped_warmup = 0
            no_cart = 0
            included = 0
            t = start
            warmup_end = start + timedelta(minutes=2)
            while t + timedelta(minutes=1) <= end:
                t0 = t.timestamp() * 1000
                t1 = t0 + 60_000
                hits = [c for c in cart if t0 <= c["ts_ms"] < t1]
                if t < warmup_end:
                    skipped_warmup += 1
                    t += timedelta(minutes=1)
                    continue
                t += timedelta(minutes=1)
                if len(hits) < 1:
                    no_cart += 1
                    continue
                vo2 = sum(c["vo2_ml_kg_min"] for c in hits) / len(hits)
                if vo2 <= 0:
                    no_cart += 1
                    continue
                included += 1
                rows_out.append({
                    "dataset": "habits",
                    "participant": pid,
                    "activity": activity,
                    "activity_family": FAMILY.get(activity, FAMILY.get(activity.strip(), "daily_activity")),
                    "start_ms": int(t0),
                    "target_met": round(vo2 / 3.5, 4),
                    "criterion_vo2_ml_kg_min": round(vo2, 4),
                    "criterion_met": round(vo2 / 3.5, 4),
                    "cart_mets_rounded": round(sum(c["cart_mets_rounded"] for c in hits) / len(hits), 4),
                    "label_source": "vo2_ml_kg_min_over_3.5_from_metcart_60s",
                })
            ledger.append({
                "dataset": "habits",
                "participant": pid,
                "activity": activity,
                "candidate_minutes": protocol_min,
                "included_minutes": included,
                "excluded_minutes": protocol_min - included,
                "exclusion_reason": (
                    f"warmup_first_2min={skipped_warmup};no_cart_or_nonpositive_vo2={no_cart}"
                    + (f";{gap}" if gap else "")
                ),
            })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    inv_path = OUT.parent / "habits_release_inventory.json"
    inv_path.write_text(json.dumps({
        "paper": {"participants": 26, "in_lab_minutes": 1838},
        "release_folders": len(inventory),
        "participants": inventory,
        "p1007": next((p for p in inventory if p["participant"] == "P1007"), None),
        "p1011": next((p for p in inventory if p["participant"] == "P1011"), None),
        "p1009": next((p for p in inventory if p["participant"] == "P1009"), None),
        "p1014": next((p for p in inventory if p["participant"] == "P1014"), None),
        "target": {
            "criterion_vo2_ml_kg_min": "MetCart 60s VO2/kg column",
            "criterion_met": "criterion_vo2_ml_kg_min / 3.5",
            "cart_mets_rounded": "printer METS column; round(VO2/kg/3.5, 1); not Weir",
            "not_used": "Ainsworth, Google Fit, clamp-below-1.0 public in-lab.py",
        },
    }, indent=2) + "\n")
    led_path = OUT.parent / "habits_index_ledger.csv"
    if ledger:
        with led_path.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(ledger[0]))
            w.writeheader()
            w.writerows(ledger)
    if not rows_out:
        print(json.dumps({"n": 0, "error": "no_habits_minutes"}))
        return
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_out[0]))
        w.writeheader()
        w.writerows(rows_out)
    fam = {}
    for r in rows_out:
        fam[r["activity_family"]] = fam.get(r["activity_family"], 0) + 1
    print(json.dumps({
        "n": len(rows_out),
        "participants": len({r["participant"] for r in rows_out}),
        "by_family": fam,
        "out": str(OUT),
        "inventory": str(inv_path),
        "ledger": str(led_path),
    }))


if __name__ == "__main__":
    main()
