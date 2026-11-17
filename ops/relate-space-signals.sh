#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# Detector for the Relate Graph Space: polls Main's Relate graph for
# unconsumed (:SpaceSignal) nodes written by the Space's chat / dispatch /
# create-graph actions. The graph is the source of truth (consumed flags);
# this script additionally persists a small wake-guard state (hash of the
# unconsumed set + last-wake timestamp + the set itself) so an unchanged
# unconsumed set cannot re-wake a worker on every poll (D-01 fix):
#   - wake immediately when the set GROWS (a tuple not seen last wake)
#   - wake again only after a 10-minute cooldown if the set is unchanged
#   - stay silent otherwise
# Ends with exactly one silent or wake.

API="http://127.0.0.1:7475/db/neo4j/query/v2"
CYPHER="MATCH (s:SpaceSignal) WHERE s.consumed = false RETURN s.kind AS kind, s.refId AS refId, s.graphSlug AS graphSlug, s.at AS at ORDER BY s.at LIMIT 50"
BODY=$(jq -n --arg stmt "$CYPHER" '{statement: $stmt, parameters: {}}')
STATE_FILE="$HOME/hooks/state/relate-space-signals.json"
COOLDOWN_SECS=600
DRY_RUN=0
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then DRY_RUN=1; fi

ERRF=$(mktemp)
RESP=$(curl --fail --silent --show-error --max-time 10 -X POST "$API" -H 'Content-Type: application/json' -d "$BODY" 2>"$ERRF") || {
  log "relate api fetch failed" "$(jq -n --arg e "$(cat "$ERRF" 2>/dev/null)" '{error: $e}')"
  rm -f "$ERRF"
  silent "relate api unreachable; staying silent" '{}'
  exit 0
}
rm -f "$ERRF"

COUNT=$(printf '%s' "$RESP" | jq -r '.data.values | length' 2>/dev/null) || COUNT=""
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  log "relate api response unparsable" '{}'
  silent "relate api response unparsable; staying silent" '{}'
  exit 0
fi

write_state() {
  # $1 = hash, $2 = lastWake epoch, $3 = signals JSON array
  [ "$DRY_RUN" -eq 1 ] && return 0
  mkdir -p "$(dirname "$STATE_FILE")"
  local tmp
  tmp=$(mktemp)
  jq -n --arg hash "$1" --argjson lastWake "$2" --argjson signals "$3" \
    '{hash: $hash, lastWake: $lastWake, signals: $signals}' > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

if [ "$COUNT" -eq 0 ]; then
  # Set drained: reset the guard so the next signal is treated as new.
  write_state "" 0 '[]'
  silent "no unconsumed SpaceSignal nodes" '{"count":0}'
  exit 0
fi

PAYLOAD=$(printf '%s' "$RESP" | jq -c '{count: (.data.values | length), signals: [.data.values[] | {kind: .[0], refId: .[1], graphSlug: .[2], at: .[3]}]}')
SIGNALS=$(printf '%s' "$PAYLOAD" | jq -c '.signals')
HASH=$(printf '%s' "$SIGNALS" | sha256sum | cut -d' ' -f1)
NOW=$(date +%s)

# Previous guard state (absent/corrupt state = never woken).
PREV_SIGNALS='[]'
PREV_LASTWAKE=0
if [ -f "$STATE_FILE" ]; then
  PREV_SIGNALS=$(jq -c '.signals // []' "$STATE_FILE" 2>/dev/null) || PREV_SIGNALS='[]'
  PREV_LASTWAKE=$(jq -r '.lastWake // 0' "$STATE_FILE" 2>/dev/null) || PREV_LASTWAKE=0
  [[ "$PREV_LASTWAKE" =~ ^[0-9]+$ ]] || PREV_LASTWAKE=0
fi

# Growth = any current tuple not present in the last-wake set.
NEW_COUNT=$(jq -n --argjson cur "$SIGNALS" --argjson prev "$PREV_SIGNALS" \
  '[ $cur[] | select(. as $s | $prev | index($s) | not) ] | length')

if [ "$NEW_COUNT" -eq 0 ] && [ $((NOW - PREV_LASTWAKE)) -lt "$COOLDOWN_SECS" ]; then
  log "unconsumed set unchanged within cooldown; staying silent" \
    "$(jq -n --arg hash "$HASH" --argjson count "$COUNT" --argjson lastWake "$PREV_LASTWAKE" '{hash: $hash, count: $count, lastWake: $lastWake}')"
  silent "unconsumed SpaceSignal set unchanged within cooldown" "$PAYLOAD"
  exit 0
fi

write_state "$HASH" "$NOW" "$SIGNALS"
log "unconsumed signals present" "$PAYLOAD"
wake "unconsumed SpaceSignal nodes in Main graph" "$PAYLOAD"
