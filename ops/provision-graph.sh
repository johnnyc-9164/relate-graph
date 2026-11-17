#!/bin/bash
# Provision a new Relate graph: init blank store, write env, start its API service.
# Usage: provision-graph.sh <slug>
#
# D-10 fix (2026-11-17): the whole run holds an flock on the registry lockfile
# (registry.json.lock), so concurrent provisions serialize instead of racing on
# nextPort. The slug is checked inside the lock: re-running for an existing slug
# is a verified no-op (same port; if its service is down it is restarted and
# re-verified, still on the same port, and its registry status is set to
# "live"). A new slug's registry entry is written with status "provisioning"
# BEFORE its service starts and is rolled back if provisioning fails, so a
# partial failure never leaves an orphan service with no registry entry.
# nextPort is never rolled back — a burned port number is harmless.
set -euo pipefail
SLUG="$1"
DIR=~/workspace/relate-space/graphs
REG="$DIR/registry.json"
LOCK="$REG.lock"
STORE="$DIR/$SLUG.rl"

exec 9>"$LOCK"
flock 9

mark_live() {
  python3 - "$REG" "$SLUG" << 'PYEOF'
import json, sys
reg_path, slug = sys.argv[1], sys.argv[2]
reg = json.load(open(reg_path))
for g in reg["graphs"]:
    if g["slug"] == slug:
        g["status"] = "live"
json.dump(reg, open(reg_path, "w"), indent=2)
print(f"{slug} is live")
PYEOF
}

# Idempotency: existing slug -> verify (heal the service if needed), exit 0.
EXISTING_PORT=$(python3 - "$REG" "$SLUG" << 'PYEOF'
import json, sys
reg = json.load(open(sys.argv[1]))
for g in reg["graphs"]:
    if g["slug"] == sys.argv[2]:
        print(g["port"])
        break
PYEOF
)
if [ -n "$EXISTING_PORT" ]; then
  if ! systemctl is-active --quiet "relate-graph@$SLUG.service"; then
    systemctl enable --now "relate-graph@$SLUG.service" || true
    sleep 2
  fi
  systemctl is-active "relate-graph@$SLUG.service"
  curl -s -H 'Content-Type: application/json' -d '{"statement":"MATCH (n) RETURN count(n) AS c"}' "http://127.0.0.1:$EXISTING_PORT/db/neo4j/query/v2"
  echo
  mark_live
  echo "already provisioned: $SLUG on port $EXISTING_PORT (no changes)"
  exit 0
fi

PORT=$(python3 -c "import json; print(json.load(open('$REG'))['nextPort'])")

# Register first (status "provisioning") so a failure below cannot orphan the service.
python3 - "$REG" "$SLUG" "$STORE" "$PORT" << 'PYEOF'
import json, sys
reg_path, slug, store, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
reg = json.load(open(reg_path))
reg["graphs"].append({"id": slug, "name": slug, "slug": slug, "store": store, "port": port, "apiBase": f"http://127.0.0.1:{port}", "service": f"relate-graph@{slug}.service", "status": "provisioning"})
reg["nextPort"] = port + 1
json.dump(reg, open(reg_path, "w"), indent=2)
print(f"registered {slug} on port {port} (provisioning)")
PYEOF

rollback() {
  python3 - "$REG" "$SLUG" << 'PYEOF'
import json, sys
reg_path, slug = sys.argv[1], sys.argv[2]
reg = json.load(open(reg_path))
reg["graphs"] = [g for g in reg["graphs"] if g["slug"] != slug]
json.dump(reg, open(reg_path, "w"), indent=2)
print(f"rolled back registry entry for {slug}")
PYEOF
}
trap 'echo "provisioning failed for $SLUG; rolling back registry entry" >&2; rollback' ERR

if [ ! -f "$STORE" ]; then
  ~/.local/bin/relate query "RETURN 1 AS init" --database "$STORE" > /dev/null
fi
printf 'DB_PATH=%s\nPORT=%s\n' "$STORE" "$PORT" > "$DIR/$SLUG.env"
cp "$DIR/relate-graph@.service" /etc/systemd/system/relate-graph@.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now "relate-graph@$SLUG.service"
sleep 2
systemctl is-active "relate-graph@$SLUG.service"
curl -s -H 'Content-Type: application/json' -d '{"statement":"MATCH (n) RETURN count(n) AS c"}' "http://127.0.0.1:$PORT/db/neo4j/query/v2"
echo
# Engine schema DDL from birth (slug constraints, vector/fulltext indexes).
~/workspace/custom-connectors/custom.relate/bin/relate ddl --api-base "http://127.0.0.1:$PORT"

mark_live
trap - ERR
