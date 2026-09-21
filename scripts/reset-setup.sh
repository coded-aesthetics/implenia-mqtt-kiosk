#!/usr/bin/env bash
# Clear this kiosk's setup so the first-start wizard runs again.
# Run from the repo root: ./scripts/reset-setup.sh
#
# Clears: active Verfahren, transport choice, MQTT settings, topic overrides.
# Keeps:  recorded sessions and readings, serial devices and channel mappings,
#         the Implenia API key and URL.
#
# This is a DEVELOPMENT AND SERVICE HELPER, not the kiosk's reset feature.
# The in-app reset still has to refuse to run while un-uploaded readings exist
# and confirm by tap — this script does neither, which is why it is not
# reachable from the UI.
#
# The Verfahren is write-once by design, so this is currently the only way to
# choose a different one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB="${DB_PATH:-$REPO_ROOT/server/kiosk.db}"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $arg" >&2
      echo "Usage: ./scripts/reset-setup.sh [--yes]" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$DB" ]; then
  echo "Nothing to do — no database at $DB"
  exit 0
fi

echo "Database: $DB"
echo

node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database(process.argv[1], { readonly: true });
const keys = ['active_verfahren', 'transport', 'mqtt_broker_url', 'mqtt_topics'];
const rows = db.prepare(
  \`SELECT key, value FROM meta WHERE key IN (\${keys.map(() => '?').join(',')})\`
).all(...keys);
const overrides = db.prepare('SELECT COUNT(*) c FROM topic_overrides').get().c;
const sessions = db.prepare('SELECT COUNT(*) c FROM recording_sessions').get().c;
const readings = db.prepare('SELECT COUNT(*) c FROM session_readings').get().c;
db.close();

console.log('Will be cleared:');
for (const k of keys) {
  const hit = rows.find((r) => r.key === k);
  console.log('  ' + k.padEnd(18) + (hit ? hit.value : '(not set)'));
}
console.log('  topic_overrides   ' + overrides + ' entr' + (overrides === 1 ? 'y' : 'ies'));
console.log();
console.log('Will be kept:');
console.log('  recorded sessions ' + sessions + ' (' + readings + ' readings)');
" "$DB"

echo
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Reset the setup? [y/N] " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database(process.argv[1]);
const tx = db.transaction(() => {
  db.prepare(
    \"DELETE FROM meta WHERE key IN ('active_verfahren','transport','mqtt_broker_url','mqtt_topics')\"
  ).run();
  db.prepare('DELETE FROM topic_overrides').run();
});
tx();
db.close();
console.log('Setup cleared.');
" "$DB"

echo
echo "Restart the server — the active Verfahren and transport are cached in memory."
