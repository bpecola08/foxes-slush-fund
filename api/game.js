// POST /api/game — { password, action, ... }.
// Password-gated organizer endpoint for setting up the next game.
// action: 'setInfo' | 'setCarryover' | 'setDrawMode' | 'setScratched' | 'open' | 'closeDraft' | 'reopenDraft' | 'rebuildDecks' | 'setStartingGoalie' | 'resetGame' | 'voidGame' | 'payAmanda' | 'factoryReset'.
//   setInfo:      { gameDate, opponent } -> { game }
//   setCarryover: { category, amountCents } -> { game }
//   setDrawMode:  { drawMode } -> { game }   ('mixed' | 'virtual' | 'physical')
//   setGamesLeft: { gamesLeft } -> { gamesLeft }   (games remaining this season; drives the home-page slush projection)
//   setScratched: { scratched: [jersey numbers] } -> { scratched, alreadyPicked }   (players out for this game; decks rebuild, drawn cards stay drawn)
//   open:         { gameDate, opponent, startingGoalie, scratched? } -> { game }
//   closeDraft:   {} -> { game }   (draft closed once the real game starts)
//   reopenDraft:  {} -> { game }   (undo a close)
//   rebuildDecks: {} -> { firstGoal: {before, after}, firstPenalty: {...}, playmaker: {...} }   (one-time fix: rebuild the open game's decks from the starting goalie, keeping drawn cards out)
//   setStartingGoalie: { startingGoalie } -> { startingGoalie, decks, conflicts }   (fix a wrong goalie pick on an open game; decks rebuild, sold plays stay)
//   transferPick: { fromTicketId, toTicketId, category } -> { category, player, fromBettor, toBettor, removedPlay }   (move one category's pick to another play — entered under the wrong person; a source play left empty is removed)
//   renameBettor: { ticketId, name } -> { ticketId, oldName, newName, familyId }   (put a clear name on a play entered under a vague one, e.g. "Grandparents")
//   resetGame:    {} -> { logged }   (saves the finished game to the Game Log, then clears back to setup; merged in from the old resetGame function)
//   payAmanda:    {} -> { paidCents, paidAt }   (records the slush as sent to Amanda and zeroes the amount owed; merged in from the old payAmanda function)
//   factoryReset: {} -> {}   (wipes plays, pots, wallets, slush and the Game Log; the organizer password survives; merged in from the old factoryReset function)
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
  if (action === 'setGamesLeft') {
    const gamesLeft = await db.withState((state) => {
      const n = logic.setGamesLeft(state, body.gamesLeft);
      return { result: n };
    });
    return { gamesLeft };
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
  if (action === 'transferPick') {
    const out = await db.withState((state) => {
      const r = logic.transferPick(state, {
        fromTicketId: body.fromTicketId,
        toTicketId: body.toTicketId,
        category: body.category,
      });
      return { result: r };
    });
    return { ...out };
  }
  if (action === 'renameBettor') {
    const out = await db.withState((state) => {
      const r = logic.renameBettor(state, {
        ticketId: body.ticketId,
        name: body.name,
      });
      return { result: r };
    });
    return { ...out };
  }
  if (action === 'resetGame') {
    const out = await db.withState((state) => {
      const r = logic.resetGame(state);
      return {
        result: r,
        logEntry: r.logged ? r.entry : null,
        nextGameId: `game-${Date.now().toString(36)}`,
      };
    });
    return { logged: out.logged };
  }
  if (action === 'voidGame') {
    const out = await db.withState((state) => {
      const r = logic.voidGame(state);
      return { result: r };
    });
    return { ...out };
  }
  if (action === 'payAmanda') {
    return db.withState((state) => logic.payAmanda(state));
  }
  if (action === 'factoryReset') {
    const firestore = db.db();
    await firestore.runTransaction(async (tx) => {
      const state = logic.createInitialState();
      // Firestore requires every read in a transaction to happen before
      // every write, so the game-log read must come first — reading it
      // after the saveState writes throws "Firestore transactions require
      // all reads to be executed before all writes."
      const logSnap = await tx.get(firestore.collection('gamelog'));
      db.saveState(firestore, tx, state, `game-${Date.now().toString(36)}`);
      for (const doc of logSnap.docs) tx.delete(doc.ref);
    });
    return {};
  }
  throw new Error(`Unknown game action: ${action}`);
});
