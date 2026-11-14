// POST /api/buyTicket — { familyId, buyer, bettor, picks } -> { ticket }.
// picks are DECK POSITIONS (indices into the shuffled decks), not player
// numbers — the client never sees the deck order. picks[c] === -1 means that
// category's deck is out: draw any player (duplicates allowed).
// bettor is the person placing the bet (one ticket per person per game);
// it falls back to buyer for older clients.
// { familyId, bettor, picks: { firstGoal: 3, firstPenalty: null, playmaker: 7 } }
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  const { familyId, buyer, bettor, picks } = body || {};
  if (!familyId || typeof picks !== 'object' || picks === null) {
    const { ApiError } = require('./_lib/db');
    throw new ApiError(400, 'invalid_argument', 'familyId and picks are required');
  }
  const ticket = await db.withState((state) => {
    const t = logic.buyTicket(state, { familyId, buyer, bettor, picks });
    return { result: t };
  });
  return { ticket };
});
