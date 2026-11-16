// POST /api/resolve — { password, action, ... }.
// Password-gated organizer endpoint for resolving winners and payouts.
// action: 'resolve' | 'setPayout' | 'roll' | 'unroll'.
//   resolve:   { category, playerNumber } -> { resolution }
//   setPayout: { category, ticketId, disposition } -> { winner }
//   roll:      { category } -> { resolution } (no winner — the pot rolls over)
//   unroll:    { category } -> { resolution: null } (undo a no-winner roll)
// disposition: 'paid' | 'rolled' | 'unmarked'
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const action = body && body.action;
  if (action === 'resolve') {
    const resolution = await db.withState((state) => {
      const r = logic.resolveCategory(state, body.category, body.playerNumber);
      return { result: r };
    });
    return { resolution };
  }
  if (action === 'setPayout') {
    const winner = await db.withState((state) => {
      const w = logic.setPayout(state, body.category, body.ticketId, body.disposition);
      return { result: w };
    });
    return { winner };
  }
  if (action === 'roll') {
    const resolution = await db.withState((state) => {
      const r = logic.rollCategory(state, body.category);
      return { result: r };
    });
    return { resolution };
  }
  if (action === 'unroll') {
    await db.withState((state) => {
      logic.unrollCategory(state, body.category);
      return { result: null };
    });
    return { resolution: null };
  }
  throw new Error(`Unknown resolve action: ${action}`);
});
