/**
 * Seed a throwaway kiosk database into the state the smoke tests look at.
 *
 * Writes through the server's own `db` module rather than raw SQL: importing it
 * is what creates the schema, and it keeps this file from carrying a second
 * copy of the DDL that would rot the first time a column is added.
 *
 * Direct writes rather than driving the UI, because starting a recording needs
 * the Implenia API — which is exactly what a smoke test must not depend on.
 * What these tests check is the layout at 1024x768, and the recording
 * lifecycle has its own unit and integration coverage.
 */

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node e2e/seed.mjs <db-path>');
  process.exit(1);
}
if (dbPath.endsWith('kiosk.db')) {
  // The same rule as server/vitest.config.ts, for the same reason: a reset test
  // once wiped a developer's real database.
  console.error(`Refusing to seed "${dbPath}" — that is a real kiosk database.`);
  process.exit(1);
}

// Must be set before the import: db.ts opens its connection at import time.
process.env.DB_PATH = dbPath;

const db = await import('../server/dist/db.js');

if (db.databasePath() !== dbPath) {
  console.error(`Refusing to seed: db opened "${db.databasePath()}", expected "${dbPath}".`);
  process.exit(1);
}

// The Verfahren decides how every sensor is interpreted; nothing renders without it.
db.setMeta('active_verfahren', 'injektionsbohren');

const sensorMap = JSON.stringify({
  bohrtiefe: { sensorId: 'sid-bohrtiefe', sensorType: 'float', unit: 'm' },
  geodin: { sensorId: 'sid-geodin', sensorType: 'int', unit: '' },
  geologie: { sensorId: 'sid-geologie', sensorType: 'string', unit: '' },
});

// createSession leaves the row in `recording`, which is what the server's
// resumeRecording() re-attaches to at boot — so the bar comes up live.
const sessionId = db.createSession('P-01', sensorMap);

const t0 = Date.now() - 300_000;
let n = 0;
// A descent to 2.9 m: close enough to the planned 3 m boundary that the geology
// suggestion is showing, which is the widest the recording bar ever gets.
for (let d = 0; d <= 2.9001; d += 0.1) {
  db.insertSessionReading(
    sessionId, 'Bohrgeraet/Tiefe', 'sid-bohrtiefe', 'float',
    Math.round(d * 1e6) / 1e6, null, { receivedAt: t0 + n * 1000 },
  );
  n++;
}

db.setElementVorgaben('P-01', {
  int_sensors: { 'Geologie 1': 5, 'Geologie 2': 9, 'Geologie 3': 10 },
  float_sensors: {
    'Tiefe Geologie 1': 3, 'Tiefe Geologie 2': 7, 'Tiefe Geologie 3': 12,
    'Säulenhöhe': 12,
  },
});

console.log(`[seed] session ${sessionId}, ${n} depth readings → ${dbPath}`);
db.close();
