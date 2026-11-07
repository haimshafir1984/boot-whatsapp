#!/usr/bin/env bash
# Launch snapshot: pulls everything needed to judge a live launch, READ-ONLY (no write to the server, no deploy, no restart).
#
#   bash scripts/launch-snapshot.sh --launch 2026-11-07T20:30:00Z            # logs since the launch time
#   bash scripts/launch-snapshot.sh --since 2h                               # or: the last N hours
#   bash scripts/launch-snapshot.sh --launch ... --label saturday-night
#
# Output goes to ~/Downloads/launch-snapshot-<label>-<timestamp>/ (NOT the repo: the logs contain phone numbers - never commit them).
# Env overrides: BIG_SVC, SMALL_SVC, GATEWAY_SVC, BIG_URL, SMALL_URL, GATEWAY_URL, TEST_PHONES (comma-separated numbers excluded from counts),
#                SSH_KEY, SSH_HOST.
set -u

SSH_KEY="${SSH_KEY:-$HOME/.ssh/flowsbiz_hetzner_ed25519}"
SSH_HOST="${SSH_HOST:-root@169.58.236.130}"
GATEWAY_SVC="${GATEWAY_SVC:-flowsbiz-admin-akr2zu}"
BIG_SVC="${BIG_SVC:-client-avshryt-prhym-meta-c02484f2-app-uxv8br}"
SMALL_SVC="${SMALL_SVC:-client-account-7330b047-gtgrbm}"
GATEWAY_URL="${GATEWAY_URL:-https://admin.flowsbiz.com}"
BIG_URL="${BIG_URL:-https://client-avshryt-prhym-meta-c02484f2.flowsbiz.com}"
SMALL_URL="${SMALL_URL:-https://client-account-7330b047.flowsbiz.com}"
BIG_ID="c02484f2"
SMALL_ID="7330b047"

LAUNCH=""; SINCE=""; LABEL="launch"
while [ $# -gt 0 ]; do
  case "$1" in
    --launch) LAUNCH="$2"; shift 2 ;;
    --since)  SINCE="$2";  shift 2 ;;
    --label)  LABEL="$2";  shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$LAUNCH" ] && [ -z "$SINCE" ]; then SINCE="6h"; fi
# docker accepts both a duration (2h) and an RFC3339 timestamp for --since
LOG_SINCE="${LAUNCH:-$SINCE}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HOME/Downloads/launch-snapshot-$LABEL-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$D"
SSH="ssh -i $SSH_KEY -o ConnectTimeout=20 -o BatchMode=yes $SSH_HOST"
CLEAN='s/^([0-9T:.Z-]+) [^ ]+ +\| /\1 /'
export TEST_PHONES="${TEST_PHONES:-972504213243,972583226413,972586100142}"

echo "== snapshot -> $D  (logs since $LOG_SINCE)"

# ---------------------------------------------------------------- 1. /health of the gateway and the two clients
echo; echo "== 1. /health"
for pair in "gateway|$GATEWAY_URL" "big|$BIG_URL" "small|$SMALL_URL"; do
  name="${pair%%|*}"; url="${pair#*|}"
  t=$(curl -s -o "$D/health-$name.json" -m 15 -w "%{http_code} %{time_total}s" "$url/health")
  echo "$name: HTTP $t"
  node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const c = j.conversations || {}, o = j.outbox || {}, g = c.metaGatewayInbox || {}, k = c.metaClientInbox || {};
      const pick = (x) => Object.entries(x).filter(([, v]) => v).map(([a, v]) => a + "=" + v).join(" ") || "all 0";
      console.log("   campaigns active/total=" + (j.campaigns || {}).active + "/" + (j.campaigns || {}).total + " | outbox: " + pick(o));
      console.log("   conversations.pending=" + c.pending + " | gatewayInbox: " + pick(g) + " | clientInbox: " + pick(k) + " | oldestDueAgeMs=" + JSON.stringify(c.inboxOldestDueAgeMs));
      console.log("   whatsapp: ready=" + (j.whatsapp || {}).ready + " lifecycle=" + (j.whatsapp || {}).lifecycle + " reconnects=" + (j.whatsapp || {}).reconnectAttempts);
    } catch (e) { console.log("   !! /health did not return JSON"); }
  ' "$D/health-$name.json"
done

# ---------------------------------------------------------------- 2. server state (one SSH call, read-only commands)
echo; echo "== 2. server"
$SSH "
  echo '--- load / memory / disk'; uptime; free -m | head -2; df -h / | tail -1
  echo '--- top containers by CPU (one sample)'
  docker stats --no-stream --format '{{.CPUPerc}}  {{.MemUsage}}  {{.Name}}' | sort -rn | head -12
  echo '--- services that are not at full replicas'
  docker service ls --format '{{.Name}} {{.Replicas}}' | awk '{split(\$2,a,\"/\"); if (a[1]!=a[2]) print}'
  echo '--- task history (restarts) of the three services'
  for s in $GATEWAY_SVC $BIG_SVC $SMALL_SVC; do echo \$s; docker service ps \$s --format '   {{.CurrentState}}  {{.Error}}' | head -4; done
" > "$D/server.txt" 2>&1
cat "$D/server.txt"

# ---------------------------------------------------------------- 3. full logs (BEFORE any deploy: a replaced container loses its log)
echo; echo "== 3. logs"
for pair in "gateway|$GATEWAY_SVC" "big|$BIG_SVC" "small|$SMALL_SVC"; do
  name="${pair%%|*}"; svc="${pair#*|}"
  $SSH "docker service logs --timestamps --since $LOG_SINCE $svc 2>&1" | sed -E "$CLEAN" > "$D/$name.log.txt"
  printf "%s: %s lines, first line: %s\n" "$name" "$(wc -l < "$D/$name.log.txt")" "$(head -n1 "$D/$name.log.txt" | cut -c1-30)"
done

# ---------------------------------------------------------------- 4. warning tags (count of each in the log window)
echo; echo "== 4. warning tags (0 is good)"
printf "%-46s %8s %8s %8s\n" "tag" "gateway" "big" "small"
for tag in META_GATEWAY_PENDING_CHECK_FAILED META_GATEWAY_CLIENT_SKIPPED META_GATEWAY_ROUTING_RETRY META_GATEWAY_FAILED \
           META_ROUTES_CACHE_REFRESH_FAILED META_GATEWAY_V1_REJECTED META_V1_BUTTON_REJECTED BUTTON_V1_LEASE_WITHHELD \
           FILE_DELIVERY_WAIT_TIMEOUT POSTGRES_BATCH_SLOW META_SEND_FAILED OUTBOX_FAILED Error; do
  printf "%-46s %8s %8s %8s\n" "$tag" "$(grep -c "$tag" "$D/gateway.log.txt")" "$(grep -c "$tag" "$D/big.log.txt")" "$(grep -c "$tag" "$D/small.log.txt")"
done

# ---------------------------------------------------------------- 5. gateway vs client analysis (the repo's existing scripts)
echo; echo "== 5. gateway vs client"
case "$SINCE" in
  *h) AGO="${SINCE%h} hours ago" ;;
  *m) AGO="${SINCE%m} minutes ago" ;;
  *)  AGO="6 hours ago" ;;
esac
FROM_ISO="${LAUNCH:-$(date -u -d "$AGO" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)}"
for pair in "big|$BIG_ID" "small|$SMALL_ID"; do
  name="${pair%%|*}"; id="${pair#*|}"
  echo "---- $name ($id)"
  ( cd "$REPO" && node scripts/compare-gateway-client.js "$D/$name.log.txt" "$D/gateway.log.txt" "$id" "$FROM_ISO" ) > "$D/compare-$name.txt" 2>&1
  head -60 "$D/compare-$name.txt"
  ( cd "$REPO" && LAUNCH_UTC="$FROM_ISO" node scripts/analyze-focus-failures.js "$D/$name.log.txt" "$D/gateway.log.txt" ) > "$D/failures-$name.txt" 2>&1
  echo "   (trend / restarts: $D/failures-$name.txt)"
done

echo; echo "== done. Everything is in: $D"
echo "   (contains phone numbers - keep it outside the repo)"
