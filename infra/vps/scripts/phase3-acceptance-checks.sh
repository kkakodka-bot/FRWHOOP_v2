#!/usr/bin/env bash
# Phase 3 acceptance checks — Kotlin twin extraction + scoring service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SECRETS="${ROOT}/infra/vps/secrets.env"
DROPLET_ENV="${ROOT}/infra/vps/droplet.env"
SSH_KEY="${ROOT}/infra/vps/keys/frwhoop_deploy"

source "$DROPLET_ENV" 2>/dev/null || true
export JAVA_HOME="${JAVA_HOME:-$(brew --prefix openjdk@17 2>/dev/null)/libexec/openjdk.jdk/Contents/Home}"

echo "========== 1a. scoped HRV/sleep parity gate (extracted JVM module) =========="
cd "${ROOT}/scoring-service"
./gradlew :analytics-kernel:test --no-daemon

echo "========== 1b. CurrentHrvTest on Android (classify kernel failure) =========="
cd "${ROOT}/android"
./gradlew testFullDebugUnitTest --tests com.noop.analytics.CurrentHrvTest --no-daemon

echo "========== 1c. full analytics oracle (android app module, unmodified) =========="
./gradlew compileFullDebugKotlin testFullDebugUnitTest --tests "com.noop.analytics.*" --no-daemon

echo "========== 2. scoring service tests + installDist =========="
cd "${ROOT}/scoring-service"
./gradlew :service:test :service:installDist --no-daemon

echo "========== 3. import scan =========="
if rg '^import (android\.|androidx\.|com\.noop\.(data|ingest))' "${ROOT}/scoring-service/" \
  | grep -v 'analytics-kernel/src/main/kotlin/android/content/SharedPreferences.kt' \
  | grep -v 'analytics-kernel/src/main/kotlin/com/noop/data/' \
  | grep -v 'Baselines.kt.*android.content.SharedPreferences'; then
  echo "FAIL: forbidden imports in scoring-service" >&2
  exit 1
fi
echo "OK: import scan clean"

echo "========== 4. migration present (scoring_service_state) =========="
test -f "${ROOT}/supabase/migrations/20260916160000_scoring_service_state.sql"
grep -q scoring_service_heartbeats "${ROOT}/supabase/migrations/20260916160000_scoring_service_state.sql"
grep -q scoring_work_items "${ROOT}/supabase/migrations/20260916160000_scoring_service_state.sql"
grep -q engine_ingest_scored "${ROOT}/supabase/migrations/20260916160000_scoring_service_state.sql"
echo "OK: scoring migration file present"

if [[ -f "$SECRETS" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS"
fi

if [[ -n "${DROPLET_IP:-}" && -f "$SSH_KEY" ]]; then
  echo "========== 5. VPS migration applied =========="
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker exec supabase-db psql -U postgres -d postgres -c \"\\d public.scoring_work_items\"" \
    | grep -q scoring_work_items && echo "OK: scoring_work_items exists on VPS"
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker exec supabase-db psql -U postgres -d postgres -c \"\\df public.engine_ingest_scored\"" \
    | grep -q engine_ingest_scored && echo "OK: engine_ingest_scored exists on VPS"
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker exec supabase-db psql -U postgres -d postgres -c \"\\d public.scoring_service_heartbeats\"" \
    | grep -q scoring_service_heartbeats && echo "OK: scoring_service_heartbeats exists on VPS"

  echo "========== 6. scoring container running (no published ports) =========="
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker compose -f /opt/frwhoop/supabase-docker/docker/docker-compose.yml ps scoring" \
    || echo "NOTE: scoring service not in compose yet"
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker port scoring 2>/dev/null || true" | grep -q . \
    && { echo "FAIL: scoring container has published ports" >&2; exit 1; } \
    || echo "OK: no published ports on scoring"

  echo "========== 7. heartbeat advancing =========="
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
    "docker exec supabase-db psql -U postgres -d postgres -tAc \"select last_poll_at from scoring_service_heartbeats where id=1\""

  if [[ -n "${REPLAY_USER_ID:-}" && -n "${REPLAY_DAY:-}" ]]; then
    echo "========== 8. replayed device-day produces server_* rows =========="
    ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
      "docker exec scoring env REPLAY_USER_ID='${REPLAY_USER_ID}' REPLAY_DAY='${REPLAY_DAY}' /app/bin/service --replay-day"
    ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
      "docker exec supabase-db psql -U postgres -d postgres -c \"select algorithm_version, hrv_rmssd_ms, sleep_total_min from server_daily_scores where user_id='${REPLAY_USER_ID}'::uuid and day='${REPLAY_DAY}'::date\""
    ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" \
      "docker exec supabase-db psql -U postgres -d postgres -c \"select count(*) as device_daily_rows from daily_metrics where user_id='${REPLAY_USER_ID}'::uuid and day='${REPLAY_DAY}'::date and provenance->>'scorer' = 'frwhoop-scoring-service'\""
  else
    echo "========== 8. replay gate (skipped — set REPLAY_USER_ID + REPLAY_DAY in secrets.env) =========="
  fi
else
  echo "========== 5–8. VPS checks skipped (no DROPLET_IP / SSH key) =========="
fi

echo "All Phase 3 automated acceptance checks finished."
