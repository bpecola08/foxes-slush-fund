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
    db.saveState(firestore, tx, state, `game-${Date.now().toString(36)}`);
    const logSnap = await tx.get(firestore.collection('gamelog'));
    for (const doc of logSnap.docs) tx.delete(doc.ref);
  });
  return {};
});
