#!/usr/bin/env bash
# 仟流智算 2.0 标准目标环境验收器。
# 默认认证烟测（登录会写 session/audit）；--full 还会执行代表性业务写入，二者分别授权。

set -euo pipefail
umask 077

MODE="smoke"
if [ "${1:-}" = "--full" ]; then
  MODE="full"
elif [ -n "${1:-}" ]; then
  echo "用法: bash deploy/scripts/verify-target.sh [--full]" >&2
  exit 2
fi

TARGET_BASE_URL="${TARGET_BASE_URL:-}"
TARGET_WEB_URL="${TARGET_WEB_URL:-}"
TARGET_ADMIN_USERNAME="${TARGET_ADMIN_USERNAME:-}"
TARGET_ADMIN_PASSWORD="${TARGET_ADMIN_PASSWORD:-}"
TARGET_EVIDENCE_DIR="${TARGET_EVIDENCE_DIR:-}"
REPRESENTATIVE_XLSX="${REPRESENTATIVE_XLSX:-}"
TARGET_MONTH="${TARGET_MONTH:-$(date +%Y-%m)}"
TARGET_CA_CERT="${TARGET_CA_CERT:-}"
TARGET_BACKUP_FILE="${TARGET_BACKUP_FILE:-}"
TARGET_RECOVERY_EVIDENCE_FILE="${TARGET_RECOVERY_EVIDENCE_FILE:-}"
TARGET_MONITOR_HEALTH_URL="${TARGET_MONITOR_HEALTH_URL:-}"

for command_name in curl jq openssl gzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: 缺少必需命令: $command_name" >&2
    exit 2
  fi
done

require_value() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "ERROR: 必须设置 $name" >&2
    exit 2
  fi
}

require_value TARGET_BASE_URL "$TARGET_BASE_URL"
require_value TARGET_WEB_URL "$TARGET_WEB_URL"
require_value TARGET_ADMIN_USERNAME "$TARGET_ADMIN_USERNAME"
require_value TARGET_ADMIN_PASSWORD "$TARGET_ADMIN_PASSWORD"
require_value TARGET_EVIDENCE_DIR "$TARGET_EVIDENCE_DIR"

is_local_http() {
  case "$1" in
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) return 0 ;;
    *) return 1 ;;
  esac
}

LOCAL_REHEARSAL=false
if [[ "$TARGET_BASE_URL" != https://* ]] || [[ "$TARGET_WEB_URL" != https://* ]]; then
  if [ "$MODE" != "smoke" ] \
    || [ "${W20_LOCAL_HTTP_ACK:-}" != "W20-11-LOCAL-SESSION" ] \
    || ! is_local_http "$TARGET_BASE_URL" \
    || ! is_local_http "$TARGET_WEB_URL"; then
    echo "ERROR: 标准目标环境 URL 必须使用 HTTPS；仅本机认证烟测可设置 W20_LOCAL_HTTP_ACK=W20-11-LOCAL-SESSION" >&2
    exit 2
  fi
  LOCAL_REHEARSAL=true
fi

if [ "$LOCAL_REHEARSAL" != "true" ] \
  && [ "${W20_TARGET_SESSION_ACK:-}" != "W20-11-SESSION:${TARGET_BASE_URL}" ]; then
  echo "ERROR: 认证烟测会创建 session/audit；需设置 W20_TARGET_SESSION_ACK=W20-11-SESSION:${TARGET_BASE_URL}" >&2
  exit 2
fi

if [ -n "$TARGET_CA_CERT" ]; then
  if [ ! -f "$TARGET_CA_CERT" ]; then
    echo "ERROR: TARGET_CA_CERT 不存在: $TARGET_CA_CERT" >&2
    exit 2
  fi
fi

curl_target() {
  if [ -n "$TARGET_CA_CERT" ]; then
    curl --cacert "$TARGET_CA_CERT" "$@"
  else
    curl "$@"
  fi
}

if [ "$MODE" = "full" ]; then
  require_value REPRESENTATIVE_XLSX "$REPRESENTATIVE_XLSX"
  require_value TARGET_BACKUP_FILE "$TARGET_BACKUP_FILE"
  require_value TARGET_RECOVERY_EVIDENCE_FILE "$TARGET_RECOVERY_EVIDENCE_FILE"
  require_value TARGET_MONITOR_HEALTH_URL "$TARGET_MONITOR_HEALTH_URL"
  if [ ! -f "$REPRESENTATIVE_XLSX" ]; then
    echo "ERROR: REPRESENTATIVE_XLSX 不存在: $REPRESENTATIVE_XLSX" >&2
    exit 2
  fi
  if [ ! -f "$TARGET_BACKUP_FILE" ] || ! gzip -t "$TARGET_BACKUP_FILE"; then
    echo "ERROR: TARGET_BACKUP_FILE 不存在或 gzip 校验失败" >&2
    exit 2
  fi
  if [ ! -f "$TARGET_RECOVERY_EVIDENCE_FILE" ] \
    || ! grep -q '^migration_head_after_restore=0045_zhipu_weekday_window_alias$' "$TARGET_RECOVERY_EVIDENCE_FILE" \
    || ! grep -q '^result=PASS$' "$TARGET_RECOVERY_EVIDENCE_FILE"; then
    echo "ERROR: TARGET_RECOVERY_EVIDENCE_FILE 未证明恢复到 0045 且 result=PASS" >&2
    exit 2
  fi
  case "$TARGET_MONITOR_HEALTH_URL" in
    https://*) ;;
    *) echo "ERROR: TARGET_MONITOR_HEALTH_URL 必须使用 HTTPS" >&2; exit 2 ;;
  esac
  if [ "${W20_TARGET_MUTATION_ACK:-}" != "W20-11:${TARGET_BASE_URL}" ]; then
    echo "ERROR: --full 需要设置 W20_TARGET_MUTATION_ACK=W20-11:${TARGET_BASE_URL}" >&2
    exit 2
  fi
fi

mkdir -p "$TARGET_EVIDENCE_DIR"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_FILE="$TARGET_EVIDENCE_DIR/W20-11-target-$RUN_ID.log"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qianliu-w20-11.XXXXXX")"
COOKIE_JAR="$TMP_DIR/cookies.txt"
RESPONSE_FILE="$TMP_DIR/response.json"

cleanup() {
  find "$TMP_DIR" -depth -delete
}
trap cleanup EXIT

PASS_COUNT=0
FAIL_COUNT=0

record() {
  printf '%s\n' "$1" | tee -a "$EVIDENCE_FILE"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  record "PASS $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  record "FAIL $1"
}

request() {
  local method="$1"
  local path="$2"
  shift 2
  curl_target --fail-with-body --silent --show-error \
    --connect-timeout 10 --max-time 60 \
    --request "$method" \
    --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" \
    --header "Accept: application/json" \
    --output "$RESPONSE_FILE" \
    "$@" "${TARGET_BASE_URL%/}$path"
}

check_json() {
  local label="$1"
  local filter="$2"
  if jq -e "$filter" "$RESPONSE_FILE" >/dev/null; then pass "$label"; else fail "$label"; fi
}

record "schema=qianliu-w20-11-target-evidence/v1"
record "started_at=$(date -Iseconds)"
record "mode=$MODE"
record "target_base_url=$TARGET_BASE_URL"
record "target_web_url=$TARGET_WEB_URL"
record "candidate_commit=c1e780686518841f31737001c4521e2e9c813867"
record "candidate_tree=baadca05ebfa038231a495f019c5085dad86519b"

if [ "$MODE" = "full" ]; then
  record "backup_sha256=$(openssl dgst -sha256 "$TARGET_BACKUP_FILE" | awk '{print $NF}')"
  record "recovery_evidence_sha256=$(openssl dgst -sha256 "$TARGET_RECOVERY_EVIDENCE_FILE" | awk '{print $NF}')"
  if curl_target --fail-with-body --silent --show-error --connect-timeout 10 --max-time 60 --output /dev/null "$TARGET_MONITOR_HEALTH_URL"; then
    pass "monitoring health"
  else
    fail "monitoring health"
  fi
fi

if request GET "/health"; then
  check_json "control-api health" '.status == "ok" and .service == "control-api"'
else
  fail "control-api health"
fi

if curl_target --fail-with-body --silent --show-error --connect-timeout 10 --max-time 60 --output "$TMP_DIR/web.html" "$TARGET_WEB_URL" \
  && test -s "$TMP_DIR/web.html"; then
  pass "web HTTPS entry"
else
  fail "web HTTPS entry"
fi

LOGIN_BODY=$(jq -n --arg username "$TARGET_ADMIN_USERNAME" --arg password "$TARGET_ADMIN_PASSWORD" \
  '{username:$username,password:$password}')
if request POST "/auth/login" --header "Content-Type: application/json" --data "$LOGIN_BODY"; then
  check_json "admin login and five feature flags" '
    .admin.id != null
    and .featureFlags.FEATURE_DIRECTORY_IMPORT == true
    and .featureFlags.FEATURE_USAGE_OVERVIEW_V2 == true
    and .featureFlags.FEATURE_DEPARTMENT_COST == true
    and .featureFlags.FEATURE_RESOURCE_UTILIZATION_V2 == true
    and .featureFlags.FEATURE_PROCUREMENT_REVIEW == true'
else
  fail "admin login and five feature flags"
fi
unset LOGIN_BODY TARGET_ADMIN_PASSWORD

if request GET "/auth/me"; then check_json "secure cookie session" '.admin.adminUserId != null'; else fail "secure cookie session"; fi
if request GET "/dashboard"; then check_json "AT-001 dashboard contract" '.resourceAccountCount != null and .monthlyTokenUsage.totalTokens != null'; else fail "AT-001 dashboard contract"; fi
if request GET "/principals?limit=1&offset=0"; then check_json "AT-001 principal compatibility" '(.principals | type) == "array"'; else fail "AT-001 principal compatibility"; fi
if request GET "/usage?limit=1&offset=0"; then check_json "AT-001 usage compatibility" '((.records // .items // .rows // []) | type) == "array"'; else fail "AT-001 usage compatibility"; fi

if request GET "/organization-units"; then check_json "AT-002 organization contract" '(.units | type) == "array"'; else fail "AT-002 organization contract"; fi
if request GET "/usage/overview?period=MONTH&subject_type=EMPLOYEE"; then check_json "AT-003 employee usage contract" '(.trend | type) == "array"'; else fail "AT-003 employee usage contract"; fi
if request GET "/usage?subject_type=PROJECT&limit=1&offset=0"; then check_json "AT-003 project usage contract" '((.records // .items // .rows // []) | type) == "array"'; else fail "AT-003 project usage contract"; fi
if request GET "/operating-bills/${TARGET_MONTH}/departments"; then check_json "AT-004 department conservation" '(.rows | type) == "array" and .conservation.status == "BALANCED"'; else fail "AT-004 department conservation"; fi
if request GET "/operating-bills/${TARGET_MONTH}"; then check_json "AT-005 operating bill contract" '.status != null and .version != null'; else fail "AT-005 operating bill contract"; fi
if request GET "/provider-resources/utilization?month=${TARGET_MONTH}"; then check_json "AT-006 utilization contract" '(.resources | type) == "array"'; else fail "AT-006 utilization contract"; fi
if request GET "/procurement-reviews/${TARGET_MONTH}"; then check_json "AT-007 procurement contract" '(.resources | type) == "array" and .note.version != null'; else fail "AT-007 procurement contract"; fi

NON_SCOPE_HTTP_CODE=$(curl_target --silent --show-error \
  --connect-timeout 10 --max-time 60 \
  --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" \
  --output "$RESPONSE_FILE" --write-out '%{http_code}' \
  "${TARGET_BASE_URL%/}/resource-accounts" 2>/dev/null || true)
if [ "$NON_SCOPE_HTTP_CODE" = "404" ]; then
  pass "AT-008 non-scope route absent"
elif [[ "$NON_SCOPE_HTTP_CODE" =~ ^2 ]]; then
  fail "AT-008 non-scope route unexpectedly exists"
else
  fail "AT-008 non-scope route check http=${NON_SCOPE_HTTP_CODE:-network_error}"
fi

if [ "$MODE" = "full" ]; then
  if request POST "/directory-excel-imports" --form "file=@${REPRESENTATIVE_XLSX};type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; then
    check_json "AT-002 representative Excel accepted" '.runId != null and (.status == "QUEUED" or .status == "RUNNING" or .status == "SUCCEEDED" or .status == "PARTIAL")'
    DIRECTORY_RUN_ID=$(jq -r '.runId // empty' "$RESPONSE_FILE")
    if [ -n "$DIRECTORY_RUN_ID" ]; then
      record "directory_run_id=$DIRECTORY_RUN_ID"
      DIRECTORY_STATUS=""
      for _ in $(seq 1 60); do
        if request GET "/directory-import-runs/${DIRECTORY_RUN_ID}"; then
          DIRECTORY_STATUS=$(jq -r '.run.status // empty' "$RESPONSE_FILE")
          case "$DIRECTORY_STATUS" in
            SUCCEEDED|PARTIAL|FAILED) break ;;
          esac
        fi
        sleep 2
      done
      if [ "$DIRECTORY_STATUS" = "SUCCEEDED" ] || [ "$DIRECTORY_STATUS" = "PARTIAL" ]; then
        pass "AT-002 representative Excel applied"
      else
        fail "AT-002 representative Excel applied status=${DIRECTORY_STATUS:-missing}"
      fi
      if request GET "/directory-import-runs/${DIRECTORY_RUN_ID}/items?limit=1&offset=0"; then
        check_json "AT-002 representative import has rows" '.total > 0 and (.items | length) > 0'
      else
        fail "AT-002 representative import has rows"
      fi
    fi
  else
    fail "AT-002 representative Excel accepted"
  fi

  if request GET "/procurement-reviews/${TARGET_MONTH}"; then
    NOTE_VERSION=$(jq -r '.note.version' "$RESPONSE_FILE")
    NOTE_KEY="w20-11-${RUN_ID}-$(openssl rand -hex 8)"
    NOTE_BODY=$(jq -n --arg note "W20-11 目标环境验收 ${RUN_ID}" --arg key "$NOTE_KEY" --argjson version "$NOTE_VERSION" \
      '{note:$note,expected_version:$version,idempotency_key:$key}')
    if request PUT "/procurement-reviews/${TARGET_MONTH}/note" --header "Content-Type: application/json" --data "$NOTE_BODY"; then
      check_json "AT-007 representative note write" '.version > 0'
    else
      fail "AT-007 representative note write"
    fi
  else
    fail "AT-007 representative note pre-read"
  fi

  if request GET "/principals?limit=1&offset=0"; then check_json "representative principals present" '.total > 0'; else fail "representative principals present"; fi
  if request GET "/usage?limit=1&offset=0"; then check_json "representative settled usage present" '.total > 0 and (.records | length) > 0'; else fail "representative settled usage present"; fi
  if request GET "/usage/overview?period=MONTH&subject_type=EMPLOYEE"; then check_json "representative usage ranking present" '(.ranking | length) > 0'; else fail "representative usage ranking present"; fi
  if request GET "/operating-bills/${TARGET_MONTH}/departments"; then check_json "representative department bill present" '(.rows | length) > 0 and .conservation.status == "BALANCED"'; else fail "representative department bill present"; fi
  if request GET "/provider-resources/utilization?month=${TARGET_MONTH}"; then check_json "representative resource utilization present" '(.resources | length) > 0'; else fail "representative resource utilization present"; fi
  if request GET "/procurement-reviews/${TARGET_MONTH}"; then check_json "representative procurement review present" '(.resources | length) > 0 and .note.version > 0'; else fail "representative procurement review present"; fi
fi

record "pass_count=$PASS_COUNT"
record "fail_count=$FAIL_COUNT"
record "ended_at=$(date -Iseconds)"
record "result=$([ "$FAIL_COUNT" -eq 0 ] && echo PASS || echo FAIL)"

if [ "$FAIL_COUNT" -ne 0 ]; then exit 1; fi
