// POST /api/backup — { password, action, ... }.
// Password-gated organizer endpoint for season backups.
// action: 'export' | 'restore'.
//   export:  {} -> { backup }   (the whole app state as one JSON object:
//             wallets, current game incl. decks and plays, season slush,
//             payments to Amanda, and the full Game Log)
//   restore: { backup } -> { gamesRestored, walletsRestored, slushCents }
//             Replaces EVERYTHING in the app with the backup — the
//             organizer password is not part of a backup and never changes.
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
  throw new Error(`Unknown backup action: ${action}`);
});
