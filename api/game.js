// POST /api/game — { password, action, ... }.
// Password-gated organizer endpoint for setting up the next game.
// action: 'setInfo' | 'setCarryover' | 'setDrawMode' | 'setScratched' | 'open' | 'closeDraft' | 'reopenDraft' | 'rebuildDecks' | 'setStartingGoalie'.
//   setInfo:      { gameDate, opponent } -> { game }
//   setCarryover: { category, amountCents } -> { game }
//   setDrawMode:  { drawMode } -> { game }   ('mixed' | 'virtual' | 'physical')
//   setScratched: { scratched: [jersey numbers] } -> { scratched, alreadyPicked }   (players out for this game; decks rebuild, drawn cards stay drawn)
//   open:         { gameDate, opponent, startingGoalie, scratched? } -> { game }
//   closeDraft:   {} -> { game }   (draft closed once the real game starts)
//   reopenDraft:  {} -> { game }   (undo a close)
//   rebuildDecks: {} -> { firstGoal: {before, after}, firstPenalty: {...}, playmaker: {...} }   (one-time fix: rebuild the open game's decks from the starting goalie, keeping drawn cards out)
//   setStartingGoalie: { startingGoalie } -> { startingGoalie, decks, conflicts }   (fix a wrong goalie pick on an open game; decks rebuild, sold plays stay)
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
  if (action === 'setScratched') {
    const out = await db.withState((state) => {
      const r = logic.setScratched(state, body.scratched);
      return { result: r };
    });
    return { ...out };
  }
  if (action === 'open') {
    const game = await db.withState((state) => {
      const g = logic.openGame(state, {
        gameDate: body.gameDate,
        opponent: body.opponent,
        startingGoalie: body.startingGoalie,
        scratched: body.scratched,
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
  if (action === 'rebuildDecks') {
    const out = await db.withState((state) => {
      const r = logic.rebuildDecks(state);
      return { result: r };
    });
    return { ...out };
  }
  if (action === 'setStartingGoalie') {
    const out = await db.withState((state) => {
      const r = logic.setStartingGoalie(state, body.startingGoalie);
      return { result: r };
    });
    return { ...out };
  }
  throw new Error(`Unknown game action: ${action}`);
});
