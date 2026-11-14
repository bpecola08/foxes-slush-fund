// POST /api/game — { password, action, ... }.
// Password-gated organizer endpoint for setting up the next game.
// action: 'setInfo' | 'setCarryover' | 'setDrawMode' | 'open' | 'closeDraft' | 'reopenDraft'.
//   setInfo:      { gameDate, opponent } -> { game }
//   setCarryover: { category, amountCents } -> { game }
//   setDrawMode:  { drawMode } -> { game }   ('mixed' | 'virtual' | 'physical')
//   open:         { gameDate, opponent, startingGoalie } -> { game }
//   closeDraft:   {} -> { game }   (draft closed once the real game starts)
//   reopenDraft:  {} -> { game }   (undo a close)
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
  if (action === 'closeDraft') {
    const game = await db.withState((state) => {
      const g = logic.closeDraft(state);
      return { result: g };
    });
    return { game };
  }
  if (action === 'reopenDraft') {
    const game = await db.withState((state) => {
      const g = logic.reopenDraft(state);
      return { result: g };
    });
    return { game };
  }
  throw new Error(`Unknown game action: ${action}`);
});
