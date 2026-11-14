// POST /api/buyTicket — { familyId, buyer, picks } -> { ticket }.
// picks are DECK POSITIONS (indices into the shuffled decks), not player
// numbers — the client never sees the deck order.
// { familyId, buyer, picks: { firstGoal: 3, firstPenalty: null, playmaker: 7 } }
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  const { familyId, buyer, picks } = body || {};
  if (!familyId || typeof picks !== 'object' || picks === null) {
    const { ApiError } = require('./_lib/db');
    throw new ApiError(400, 'invalid_argument', 'familyId and picks are required');
  }
  const ticket = await db.withState((state) => {
    const t = logic.buyTicket(state, { familyId, buyer, picks });
    return { result: t };
  });
  return { ticket };
});
