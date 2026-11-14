// POST /api/setPayout — { password, category, ticketId, disposition } -> { winner }.
// disposition: 'paid' | 'rolled' | 'unmarked'
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const winner = await db.withState((state) => {
    const w = logic.setPayout(state, body.category, body.ticketId, body.disposition);
    return { result: w };
  });
  return { winner };
});
