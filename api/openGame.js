// POST /api/openGame — { password, gameDate, opponent, startingGoalie } -> { game }.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const game = await db.withState((state) => {
    const g = logic.openGame(state, {
      gameDate: body.gameDate,
      opponent: body.opponent,
      startingGoalie: body.startingGoalie,
    });
    return { result: g };
  });
  return { game };
});
