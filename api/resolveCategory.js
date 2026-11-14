// POST /api/resolveCategory — { password, category, playerNumber } -> { resolution }.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const resolution = await db.withState((state) => {
    const r = logic.resolveCategory(state, body.category, body.playerNumber);
    return { result: r };
  });
  return { resolution };
});
