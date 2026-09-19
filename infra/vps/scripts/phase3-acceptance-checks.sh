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

echo "========== 4. physiology-v2 queue and heartbeat migrations present =========="
test -f "${ROOT}/supabase/migrations/20260918100000_physiology_independent_work.sql"
grep -q physiology_service_heartbeats "${ROOT}/supabase/migrations/20260918100000_physiology_independent_work.sql"
grep -q physiology_work_items "${ROOT}/supabase/migrations/20260918100000_physiology_independent_work.sql"
grep -q engine_publish_physiology "${ROOT}/supabase/migrations/20260918100000_physiology_independent_work.sql"
echo "OK: physiology-v2 migration file present"

if [[ -f "$SECRETS" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS"
fi

if [[ -n "${DROPLET_IP:-}" && -f "$SSH_KEY" ]]; then
  echo "========== 5–7. exact physiology-v2 container and advancing hosted heartbeat =========="
  RELEASE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
  ssh -i "$SSH_KEY" "deploy@${DROPLET_IP}" bash -s -- "$RELEASE_SHA" <<'REMOTE'
set -euo pipefail
release_sha="$1"
container="scoring-physiology-v2"
test "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")" = "$release_sha"
test "$(docker inspect -f '{{.State.Status}}' "$container")" = "running"
test -z "$(docker port "$container" 2>/dev/null || true)"
mapfile -t running_v2 < <(docker ps --no-trunc -q | while read -r id; do
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" | \
      grep -Fxq 'SCORING_ALGORITHM_VERSION=frwhoop-physiology-2'; then
    printf '%s\n' "$id"
  fi
done)
if [[ "${#running_v2[@]}" -ne 1 || "${running_v2[0]:-}" != "$(docker inspect -f '{{.Id}}' "$container")" ]]; then
  echo "FAIL: expected exactly one running physiology-v2 worker" >&2
  exit 1
fi
if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | grep -q '^REPLAY_'; then
  echo "FAIL: persistent worker contains replay-mode variables" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /opt/frwhoop/secrets.env
: "${SCORING_DATABASE_URL:?}"
snapshot() {
  docker exec supabase-db psql "$SCORING_DATABASE_URL" -X -A -t -F '|' -c \
    "select coalesce(h.version,''),coalesce(h.last_poll_at::text,''),coalesce(h.last_score_at::text,''),
       (h.last_error is null),
       (select count(*) from public.physiology_work_items w
          where w.done_at is null
            and ((w.status='running' and w.lease_expires_at>clock_timestamp())
              or w.next_attempt_at<=clock_timestamp())
            and (w.failure_revision<>w.input_revision or w.consecutive_failures<8))
     from public.physiology_service_heartbeats h where h.id=1"
}

initial="$(snapshot)"
IFS='|' read -r initial_version initial_poll initial_score initial_healthy initial_active_debt <<<"$initial"
test "$initial_version" = "frwhoop-physiology-2"
test -n "$initial_poll"
test "$initial_active_debt" -ge 0

accepted=false
for _ in {1..12}; do
  sleep 5
  current="$(snapshot)"
  IFS='|' read -r version poll score healthy active_debt <<<"$current"
  test "$version" = "frwhoop-physiology-2"
  test -n "$poll"
  test "$healthy" = "t"
  if [[ "$initial_active_debt" -eq 0 && "$poll" != "$initial_poll" ]]; then
    accepted=true
    break
  fi
  if [[ "$initial_active_debt" -gt 0 && -n "$score" && "$score" != "$initial_score" ]]; then
    accepted=true
    break
  fi
done
if [[ "$accepted" != true ]]; then
  echo "FAIL: physiology worker showed no healthy queue progress within 60 seconds" >&2
  exit 1
fi
echo "OK: exact image, persistent mode, no ports, healthy heartbeat, and queue progress"
REMOTE
else
  echo "========== 5–7. VPS checks skipped (no DROPLET_IP / SSH key) =========="
fi

echo "All Phase 3 automated acceptance checks finished."
