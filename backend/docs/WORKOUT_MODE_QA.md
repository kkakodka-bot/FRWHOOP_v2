# Workout Mode physical QA

Detector version: `1.2.0`. Canonical session after confirm. Shadow default: detect, **do not buzz**.

Haptic was **not** fired on WHOOP 4 / 5 / MG in this environment. Do not enable **Strap buzz on detect** until this checklist passes on hardware.

## Before a field pass

- Host API reachable from the phone (`VITE_API_URL`, LAN IP, not bind-localhost-only).
- Native live POST includes `X-FRWHOOP-DEVICE-TOKEN`. LAN without that header is 401.
- Settings: Workout detection **on**, Strap buzz **off** (shadow).
- After hardware QA, enable strap buzz for one tester, then a small rollout percentage.

## Confirm paths (what you should see)

| Situation | Confirm | Buzz (if haptics enabled) |
| --- | --- | --- |
| Motion + HR onset | ~3 min | once, session id |
| HR only (desk / no IMU) | ~8 min | once |
| Unevaluable onset | ~12 min | once |
| Stairs, phone in pocket | may look like motion | HR-only path is what stops a 3 min desk false buzz when strap IMU is absent |

Phone IMU is `\|√(x²+y²+z²) − 1\|` at ~1 Hz. Strap IMU is parsed from live type **43** only. This app does **not** send WHOOP IMU-enable commands.

## Hardware checklist (WHOOP 4.0, 5.0, MG)

Run each row on every generation you ship. One session id must drive haptic, Workout Mode, Live Activity, and the event ledger.

Software for these rows is in the native app (Live Activity timer, deep link, background live POST, buzz retry, crash restore). **Physical strap buzz and a locked iPhone still have to be confirmed on hardware.** Do not mark a row done until it passes on a real 4.0 / 5.0 / MG.

1. Start a real workout. **One** buzz at confirm. No second buzz on the same session.
2. Lock the phone. Lock Screen / Dynamic Island (iOS 16.2+) shows `Workout • mm:ss` and `HR • Zone`. Tap opens Workout Mode (`frwhoop://workout/{id}`).
3. Background the app. Live HR keeps posting; Workout Mode still tracks. Phone motion continues while the process is awake (BLE notify).
4. Disconnect the strap ~2 min, reconnect. Session **does not** split. No extra buzz. A missed buzz while disconnected is retried once after rebond (in-memory only — a crash still must not re-buzz).
5. Rest 2–3 min mid-set (lifting). Session stays open (`endConfirmS` is 4 min).
6. End Workout in the app. Session completes, activity is stored locally, ledger has `workout_ended_*` / `workout_persisted`.
7. Not a workout / dismiss. No persisted workout; no further buzz for that onset.
8. Kill and relaunch the app mid-session. Workout Mode and Live Activity resume the **same** id. **No** re-buzz.
9. Forgotten strap (no samples ~30 min) or max length (6 h) auto-ends. Nothing left running forever.
10. Confirm the workout row exists locally **and** in Supabase after sync.

## Shadow / kill switch

- `auto_workout_haptics_enabled` default **false**.
- `auto_workout_rollout_percentage` `0` disables detect.
- Host `/api/host/runtime` mirrors the same flags for the LAN detector.

## Not verified here

Physical strap buzz on WHOOP 4 / 5 / MG, Lock Screen / Dynamic Island on a locked iPhone, and background BLE + CoreMotion while the phone is in a pocket. The software paths exist; those rows still require the hardware checklist above.
