#!/usr/bin/env bash
# Clear this kiosk's setup so the first-start wizard runs again.
# Run from the repo root: ./scripts/reset-setup.sh [--yes] [--with-data [--force]]
#
# Default      Clears the active Verfahren, transport choice, MQTT settings and
#              topic overrides. Keeps recorded sessions and readings, serial
#              devices and channel mappings, and the Implenia API credentials.
#
# --with-data  Also deletes recorded sessions and readings, the buffer, devices
#              and channel mappings — everything the in-app reset clears. This
#              is the escape hatch for data that will never upload: the in-app
#              reset refuses while readings are neither uploaded nor exported,
#              and this ignores that guard. Always asks separately; --yes does
#              not cover it, --force does.
#
# This is a DEVELOPMENT AND SERVICE HELPER, not the kiosk's reset feature. The
# in-app reset (Einstellungen → Zurücksetzen) is the one with the data guard.
#
# The Verfahren and the transport are write-once by design, so this is the only
# way to change them short of the in-app reset.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB="${DB_PATH:-$REPO_ROOT/server/kiosk.db}"
ASSUME_YES=0
WITH_DATA=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --with-data) WITH_DATA=1 ;;
    --force) FORCE=1 ;;
    --help|-h)
      sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $arg" >&2
      echo "Usage: ./scripts/reset-setup.sh [--yes] [--with-data [--force]]" >&2
      exit 1
      ;;
  esac
done

if [ "$FORCE" -eq 1 ] && [ "$WITH_DATA" -eq 0 ]; then
  echo "ERROR: --force only applies together with --with-data" >&2
  exit 1
fi

if [ ! -f "$DB" ]; then
  echo "Nothing to do — no database at $DB"
  exit 0
fi

echo "Database: $DB"
echo

node --input-type=module -e "
import Database from 'better-sqlite3';
const [dbPath, withData] = process.argv.slice(1);
const db = new Database(dbPath, { readonly: true });
const keys = ['active_verfahren', 'transport', 'mqtt_broker_url', 'mqtt_topics'];
const rows = db.prepare(
  \`SELECT key, value FROM meta WHERE key IN (\${keys.map(() => '?').join(',')})\`
).all(...keys);
const count = (t) => db.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
const overrides = count('topic_overrides');
const sessions = count('recording_sessions');
const readings = count('session_readings');
const devices = count('devices');
const mappings = count('sensor_mappings');
db.close();

console.log('Will be cleared:');
for (const k of keys) {
  const hit = rows.find((r) => r.key === k);
  console.log('  ' + k.padEnd(18) + (hit ? hit.value : '(not set)'));
}
console.log('  topic_overrides   ' + overrides);
if (withData === '1') {
  console.log();
  console.log('Will be DESTROYED (--with-data):');
  console.log('  recorded sessions ' + sessions + ' (' + readings + ' readings)');
  console.log('  devices           ' + devices + ' (' + mappings + ' channel mappings)');
} else {
  console.log();
  console.log('Will be kept:');
  console.log('  recorded sessions ' + sessions + ' (' + readings + ' readings)');
  console.log('  devices           ' + devices + ' (' + mappings + ' channel mappings)');
  if (sessions > 0) {
    console.log();
    console.log('  NOTE: those sessions were recorded under the Verfahren being cleared.');
    console.log('        Exports resolve their columns against the *active* Verfahren, so');
    console.log('        after choosing a different one they would export incorrectly.');
    console.log('        Use --with-data for a clean slate.');
  }
}
console.log();
console.log('Always kept: API key, server address');
" "$DB" "$WITH_DATA"

echo
if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Reset the setup? [y/N] " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# Destroying recordings gets its own confirmation. --yes deliberately does not
# cover it: the common case is re-running the wizard, not discarding data.
if [ "$WITH_DATA" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
  echo
  echo "This permanently deletes recorded measurements that may never have left this kiosk."
  read -r -p "Type DELETE DATA to confirm: " confirm
  if [ "$confirm" != "DELETE DATA" ]; then
    echo "Aborted — nothing was changed."
    exit 1
  fi
fi

node --input-type=module -e "
import Database from 'better-sqlite3';
const [dbPath, withData] = process.argv.slice(1);
const db = new Database(dbPath);
const tx = db.transaction(() => {
  db.prepare(
    \"DELETE FROM meta WHERE key NOT IN ('implenia_api_key','implenia_api_url')\"
  ).run();
  db.prepare('DELETE FROM topic_overrides').run();
  if (withData === '1') {
    db.prepare('DELETE FROM session_readings').run();
    db.prepare('DELETE FROM recording_sessions').run();
    db.prepare('DELETE FROM mqtt_buffer').run();
    db.prepare('DELETE FROM sensor_mappings').run();
    db.prepare('DELETE FROM devices').run();
  }
});
tx();
db.close();
console.log(withData === '1' ? 'Setup and recorded data cleared.' : 'Setup cleared.');
" "$DB" "$WITH_DATA"

echo
echo "Restart the server — the active Verfahren and transport are cached in memory."
