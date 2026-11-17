#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# Self-heal watch for the Relate graph stack. /etc is ephemeral across VM
# replacements, so the systemd units vanish and every graph API goes down.
# This script polls every registered graph API; when any is down it runs the
# canonical heal (~/workspace/relate-space/ensure-all.sh — reinstalls units
# from persistent home copies, starts services + Ollama, verifies counts)
# itself, with no agent in the loop. It wakes a worker ONLY when the heal
# runs and something is still down (10-minute wake cooldown while an outage
# persists). Ends with exactly one silent or wake.

REGISTRY="$HOME/workspace/relate-space/graphs/registry.json"
ENSURE="$HOME/workspace/relate-space/ensure-all.sh"
STATE_FILE="$HOME/hooks/state/relate-api-watch.json"
COOLDOWN_SECS=600
DRY_RUN=0
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then DRY_RUN=1; fi

check_down() {
  # prints one slug per line for each registered graph whose API is down
  jq -r '.graphs[] | "\(.slug) \(.apiBase)"' "$REGISTRY" 2>/dev/null | while read -r slug api; do
    [ -n "$slug" ] || continue
    ok=$(curl -s -m 5 -X POST "$api/db/neo4j/query/v2" \
      -H 'Content-Type: application/json' \
      -d '{"statement":"MATCH (n) RETURN count(n) AS c","parameters":{}}' 2>/dev/null \
      | jq -r '.data.values[0][0] // empty' 2>/dev/null) || ok=""
    if [ -z "$ok" ]; then echo "$slug"; fi
  done
}

DOWN=$(check_down || true)

if [ -z "$DOWN" ]; then
  silent "all relate graph APIs healthy" '{}'
  exit 0
fi

DOWN_JSON=$(printf '%s\n' "$DOWN" | jq -R . | jq -s '{down: .}')

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: graph APIs down, heal would run" "$DOWN_JSON"
  wake "dry run: relate graph APIs down (heal skipped in dry run)" "$DOWN_JSON"
  exit 0
fi

HEAL_OUT=$("$ENSURE" 2>&1) || true
log "auto-heal ran" "$(jq -n --arg out "$HEAL_OUT" --argjson down "$DOWN_JSON" '{heal: $out, wasDown: $down.down}')"

DOWN_AFTER=$(check_down || true)
if [ -z "$DOWN_AFTER" ]; then
  silent "graph APIs were down and auto-healed" "$DOWN_JSON"
  exit 0
fi

# Still down after a heal: wake a worker, at most once per cooldown window.
NOW=$(date +%s)
LAST=0
if [ -f "$STATE_FILE" ]; then
  LAST=$(jq -r '.lastWake // 0' "$STATE_FILE" 2>/dev/null) || LAST=0
  [[ "$LAST" =~ ^[0-9]+$ ]] || LAST=0
fi
if [ $((NOW - LAST)) -ge "$COOLDOWN_SECS" ]; then
  mkdir -p "$(dirname "$STATE_FILE")"
  jq -n --argjson ts "$NOW" '{lastWake: $ts}' >"$STATE_FILE"
  STILL_JSON=$(printf '%s\n' "$DOWN_AFTER" | jq -R . | jq -s '{stillDown: .}')
  wake "relate graph APIs still down after auto-heal" "$(jq -n --argjson s "$STILL_JSON" --arg heal "$(printf '%s' "$HEAL_OUT" | tail -3)" '{stillDown: $s.stillDown, healTail: $heal}')"
  exit 0
fi

silent "graph APIs still down after auto-heal; wake in cooldown" "$DOWN_JSON"
