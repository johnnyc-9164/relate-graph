#!/usr/bin/env bash
# ensure-all.sh — make the whole Relate stack be up, healing whatever a VM
# replacement wiped. THE canonical heal path (ensure-api.sh delegates here).
#
# Why this exists: /etc is ephemeral across VM replacements, so the systemd
# units vanish and every graph API goes down until something reinstalls them.
# The canonical unit copies live in this directory (persistent home storage).
# This script:
#   1. reinstalls both units into /etc/systemd/system when missing or stale
#   2. enables + starts every registered graph service
#   3. starts the Ollama embedding runtime if it is down (same launch the
#      relate CLI uses on demand)
#   4. verifies every API with a live count query
# Idempotent. Prints one OK line per component; exit 0 only when all healthy.
set -uo pipefail

SPACE_DIR="$HOME/workspace/relate-space"
REGISTRY="$SPACE_DIR/graphs/registry.json"
SYSTEMD_DIR=/etc/systemd/system
changed=0

install_unit() {
  local src="$1" name="$2"
  if [ ! -f "$SYSTEMD_DIR/$name" ] || ! cmp -s "$src" "$SYSTEMD_DIR/$name"; then
    cp "$src" "$SYSTEMD_DIR/$name"
    changed=1
  fi
}

install_unit "$SPACE_DIR/relate-api.service" relate-api.service
install_unit "$SPACE_DIR/graphs/relate-graph@.service" relate-graph@.service
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  echo "UNITS reinstalled from canonical copies"
fi

failures=""
services_file=$(mktemp)
python3 - "$REGISTRY" >"$services_file" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
for g in reg["graphs"]:
    print(g["slug"], g["service"], g["apiBase"])
PY

while read -r slug service api; do
  [ -n "$slug" ] || continue
  systemctl enable "$service" >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet "$service"; then
    systemctl start "$service" 2>/dev/null || failures="$failures $slug:start-failed"
    sleep 1
  fi
  count=$(curl -s -m 5 -X POST "$api/db/neo4j/query/v2" \
    -H 'Content-Type: application/json' \
    -d '{"statement":"MATCH (n) RETURN count(n) AS c","parameters":{}}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['values'][0][0])" 2>/dev/null)
  if [ -z "$count" ]; then
    failures="$failures $slug:api-down"
  else
    echo "OK $slug nodes=$count"
  fi
done <"$services_file"
rm -f "$services_file"

# Ollama embedding runtime — same launch bin/relate uses on demand.
if ! curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  mkdir -p "$HOME/workspace/relate-runtime/logs"
  OLLAMA_MODELS="$HOME/workspace/relate-runtime/models" \
  OLLAMA_HOST=127.0.0.1:11434 \
    nohup "$HOME/workspace/relate-runtime/ollama/bin/ollama" serve \
    >>"$HOME/workspace/relate-runtime/logs/ollama-serve.log" 2>&1 &
  for _ in $(seq 1 15); do
    curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi
if curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "OK ollama up"
else
  failures="$failures ollama:api-down"
fi

if [ -n "$failures" ]; then
  echo "FAILED:$failures"
  exit 1
fi
echo "ALL HEALTHY"
