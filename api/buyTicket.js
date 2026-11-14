// POST /api/buyTicket — { familyId, buyer, bettor, picks, mode, payLater } -> { ticket }.
// Virtual (default): picks are DECK POSITIONS (indices into the shuffled
// decks), not player numbers — the client never sees the deck order.
// picks[c] === -1 means that category's deck is out: draw any player
// (duplicates allowed).
// Physical (mode === 'physical'): picks are PLAYER NUMBERS the bettor drew
// from the real chip bag. One shared deck backs both modes, so a player
// already drawn is gone and a physical pick of them is rejected.
// bettor is the person placing the bet (one ticket per person per game);
// it falls back to buyer for older clients.
// payLater: the parent chose "Play now pay later" — the ticket goes through
// even if the wallet is short, and the balance goes negative until the
// organizer records a deposit.
// { familyId, bettor, picks: { firstGoal: 3, firstPenalty: null, playmaker: 7 } }
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  const { familyId, buyer, bettor, picks, mode, payLater } = body || {};
  if (!familyId || typeof picks !== 'object' || picks === null) {
    const { ApiError } = require('./_lib/db');
    throw new ApiError(400, 'invalid_argument', 'familyId and picks are required');
  }
  const ticket = await db.withState((state) => {
    const t = logic.buyTicket(state, { familyId, buyer, bettor, picks, mode, payLater });
    return { result: t };
  });
  return { ticket };
});
