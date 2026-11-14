// POST /api/game — { password, action, ... }.
// Password-gated organizer endpoint for setting up the next game.
// action: 'setInfo' | 'setCarryover' | 'setDrawMode' | 'open'.
//   setInfo:      { gameDate, opponent } -> { game }
//   setCarryover: { category, amountCents } -> { game }
//   setDrawMode:  { drawMode } -> { game }   ('mixed' | 'virtual' | 'physical')
//   open:         { gameDate, opponent, startingGoalie } -> { game }
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const action = body && body.action;
  if (action === 'setInfo') {
    const game = await db.withState((state) => {
      const g = logic.setGameInfo(state, {
        gameDate: body.gameDate,
        opponent: body.opponent,
      });
      return { result: g };
    });
    return { game };
  }
  if (action === 'setCarryover') {
    const game = await db.withState((state) => {
      const g = logic.setCarryover(state, body.category, body.amountCents);
      return { result: g };
    });
    return { game };
  }
  if (action === 'setDrawMode') {
    const game = await db.withState((state) => {
      const g = logic.setDrawMode(state, body.drawMode);
      return { result: g };
    });
    return { game };
  }
  if (action === 'open') {
    const game = await db.withState((state) => {
      const g = logic.openGame(state, {
        gameDate: body.gameDate,
        opponent: body.opponent,
        startingGoalie: body.startingGoalie,
      });
      return { result: g };
    });
    return { game };
  }
  throw new Error(`Unknown game action: ${action}`);
});
