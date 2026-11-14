// POST /api/factoryReset — { password } -> { ok: true }.
// Password-gated factory reset: wipes tickets, pots, carryovers, slush,
// wallets ($0) and the game log. The organizer password survives (it lives
// in private/organizer, untouched by this function).
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const firestore = db.db();
  await firestore.runTransaction(async (tx) => {
    const state = logic.createInitialState();
    // Firestore requires every read in a transaction to happen before every
    // write, so the game-log read must come first — reading it after the
    // saveState writes is what produced "Firestore transactions require all
    // reads to be executed before all writes."
    const logSnap = await tx.get(firestore.collection('gamelog'));
    db.saveState(firestore, tx, state, `game-${Date.now().toString(36)}`);
    for (const doc of logSnap.docs) tx.delete(doc.ref);
  });
  return {};
});
