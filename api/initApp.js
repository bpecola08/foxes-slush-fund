// POST /api/initApp — { password } — seed wallets + game row on first run
// (organizer only; no-op if already seeded).
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const firestore = db.db();
  const snap = await firestore.doc(db.GAME_DOC).get();
  if (snap.exists) return { seeded: false };
  const state = logic.createInitialState();
  await firestore.runTransaction(async (tx) => {
    db.saveState(firestore, tx, state, 'game-1');
  });
  return { seeded: true };
});
