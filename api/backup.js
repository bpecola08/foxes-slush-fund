// POST /api/backup — { password, action, ... }.
// Password-gated organizer endpoint for season backups.
// action: 'export' | 'restore' | 'importLog'.
//   export:    {} -> { backup }   (the whole app state as one JSON object:
//              wallets, current game incl. decks and plays, season slush,
//              payments to Amanda, and the full Game Log)
//   restore:   { backup } -> { gamesRestored, walletsRestored, slushCents }
//              Replaces EVERYTHING in the app with the backup — the
//              organizer password is not part of a backup and never changes.
//   importLog: { entries } -> { imported, skipped }
//              Adds Game Log entries (e.g. older games rebuilt from the old
//              pool dashboard). Add-only: a game whose date + opponent is
//              already in the log is skipped, and wallets, slush and the
//              current game are never touched.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const action = body && body.action;
  if (action === 'export') {
    const firestore = db.db();
    const backup = await firestore.runTransaction(async (tx) => {
      const state = await db.loadState(firestore, tx);
      const logSnap = await tx.get(
        firestore.collection('gamelog').orderBy('endedAt', 'desc')
      );
      const entries = logSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
      return logic.buildBackup(state, entries);
    });
    return { backup };
  }
  if (action === 'restore') {
    const summary = await db.withState((state) => {
      const r = logic.applyBackup(state, body.backup);
      return { result: r.summary, replaceLog: r.logEntries };
    });
    return { ...summary };
  }
  if (action === 'importLog') {
    const entries = logic.validateImportEntries(body.entries);
    const firestore = db.db();
    return firestore.runTransaction(async (tx) => {
      // Read first (Firestore: all reads before all writes), then insert
      // only the games that are not already logged.
      const snap = await tx.get(firestore.collection('gamelog'));
      const existing = new Set(
        snap.docs.map((d) => `${d.data().gameDate}|${d.data().opponent}`)
      );
      let imported = 0;
      let skipped = 0;
      for (const entry of entries) {
        const key = `${entry.gameDate}|${entry.opponent}`;
        if (existing.has(key)) {
          skipped++;
          continue;
        }
        const ref = firestore.collection('gamelog').doc();
        tx.set(ref, { ...entry, id: ref.id });
        existing.add(key);
        imported++;
      }
      return { imported, skipped };
    });
  }
  throw new Error(`Unknown backup action: ${action}`);
});
