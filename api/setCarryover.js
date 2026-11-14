// POST /api/setCarryover — { password, category, amountCents } -> { game }.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const game = await db.withState((state) => {
    const g = logic.setCarryover(state, body.category, body.amountCents);
    return { result: g };
  });
  return { game };
});
