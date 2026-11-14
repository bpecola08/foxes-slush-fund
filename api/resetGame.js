// POST /api/resetGame — { password } -> { logged }.
// Saves the finished game to the Game Log first, then clears and returns to
// setup. A new game id is issued so the next game's tickets can't collide.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const out = await db.withState((state) => {
    const r = logic.resetGame(state);
    return {
      result: r,
      logEntry: r.logged ? r.entry : null,
      nextGameId: `game-${Date.now().toString(36)}`,
    };
  });
  return { logged: out.logged };
});
