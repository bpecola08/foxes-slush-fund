// Unit tests for the money logic (lib/logic.js) and password hashing
// (lib/auth.js). Run with:  npm test   (from the project root)
// These tests run against the pure logic only — no Firebase, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../lib/logic');
const { hashPassword, verifyPassword } = require('../lib/auth');

const { createInitialState, deposit, buyTicket, resolveCategory, rollCategory, unrollCategory, setPayout,
  resetGame, voidGame, factoryReset, openGame, closeDraft, reopenDraft, rebuildDecks, setStartingGoalie, setCarryover, setGameInfo, payAmanda, setDrawMode, setGamesLeft, setScratched, buildBackup, applyBackup, validateImportEntries, correctSlush, logFixDelta, setWalletBalances } = logic;

// Deterministic RNG (LCG) so shuffles are reproducible in tests.
function seededRng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

// A fresh state with a game open and one family funded with $20.
function fundedGame() {
  const state = createInitialState();
  deposit(state, '22', 2000); // Liam's family: $20
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  return state;
}

function buyFullTicket(state, familyId, buyer) {
  return buyTicket(state, { familyId, buyer, picks: { firstGoal: 0, firstPenalty: 0, playmaker: 0 } });
}

// ---------------------------------------------------------------------------
// Deposits and ticket purchases
// ---------------------------------------------------------------------------

test('deposit adds to the wallet; $20 deposit then $6 buy leaves $14', () => {
  const state = fundedGame();
  assert.equal(state.wallets['22'].balanceCents, 2000);
  const t = buyFullTicket(state, '22', 'Trish');
  assert.equal(t.paidCents, 600);
  assert.equal(state.wallets['22'].balanceCents, 1400);
  assert.deepEqual(state.game.pots, { firstGoal: 100, firstPenalty: 100, playmaker: 100 });
  assert.equal(state.slushCents, 300); // $1 per category to the slush
  assert.equal(state.game.slushGameCents, 300);
});

test('buying a ticket draws distinct players within a category', () => {
  const state = createInitialState();
  for (const n of [9, 16, 17, 19, 20, 22, 23, 24]) deposit(state, String(n), 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng(7) });
  const firstGoalPicks = [];
  for (const n of [9, 16, 17, 19, 20, 22, 23, 24]) {
    const t = buyTicket(state, { familyId: String(n), buyer: `buyer-${n}`, picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
    firstGoalPicks.push(t.picks.firstGoal.number);
  }
  assert.equal(new Set(firstGoalPicks).size, 8, '8 draws from one deck must be 8 different players');
  assert.equal(state.game.pots.firstGoal, 800);
  assert.equal(state.slushCents, 800);
});

test('the same player may appear in two categories on one ticket (independent decks)', () => {
  const state = fundedGame();
  // Force both decks to the same order so the top card is the same player.
  state.game.decks.firstGoal = [9, 16, 17, 19, 20, 22, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98];
  state.game.decks.playmaker = [9, 16, 17, 19, 20, 22, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98];
  const t = buyTicket(state, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: 0 } });
  assert.equal(t.picks.firstGoal.number, 9);
  assert.equal(t.picks.playmaker.number, 9);
  assert.equal(t.paidCents, 400);
});

test('buying with insufficient funds, twice, or with no open game throws', () => {
  const state = createInitialState();
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  assert.throws(() => buyFullTicket(state, '22', 'Trish'), /Insufficient wallet balance/);
  deposit(state, '22', 600);
  buyFullTicket(state, '22', 'Trish');
  assert.throws(() => buyFullTicket(state, '22', 'Trish'), /already has a play/);
  assert.throws(
    () => buyTicket(state, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 99, firstPenalty: null, playmaker: null } }),
    /already has a play/
  );

  const closed = createInitialState();
  assert.throws(() => buyFullTicket(closed, '22', 'Trish'), /No game is open/);
});

test('several people in one family can each buy a ticket; the same person cannot buy twice', () => {
  const state = fundedGame(); // Liam's family funded $20
  const t1 = buyTicket(state, { familyId: '22', bettor: 'Trish Adair', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  const t2 = buyTicket(state, { familyId: '22', bettor: 'Brandon Pecola', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  const t3 = buyTicket(state, { familyId: '22', bettor: 'Grandma', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  assert.equal(t1.bettor, 'Trish Adair');
  assert.equal(t2.bettor, 'Brandon Pecola');
  assert.equal(t3.buyer, 'Grandma');
  assert.equal(state.tickets.length, 3);
  assert.equal(state.wallets['22'].balanceCents, 2000 - 3 * 200);
  assert.throws(
    () => buyTicket(state, { familyId: '22', bettor: 'Trish Adair', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } }),
    /already has a play/
  );
});

test('a -1 pick draws any player when the deck for a category is out', () => {
  const state = fundedGame();
  state.game.decks.firstGoal = []; // deck exhausted
  const t = buyTicket(state, { familyId: '22', bettor: 'Trish', picks: { firstGoal: -1, firstPenalty: null, playmaker: null } });
  assert.ok(t.picks.firstGoal && typeof t.picks.firstGoal.number === 'number');
  assert.ok([9, 16, 17, 19, 20, 22, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98].includes(t.picks.firstGoal.number));
  assert.equal(t.paidCents, 200);
});

test('physical (real chip) picks use player numbers and share the deck with virtual', () => {
  const state = fundedGame();
  const num = state.game.decks.firstGoal[0];
  const t = buyTicket(state, {
    familyId: '22',
    bettor: 'Trish',
    picks: { firstGoal: num, firstPenalty: null, playmaker: null },
    mode: 'physical',
  });
  assert.equal(t.mode, 'physical');
  assert.equal(t.picks.firstGoal.number, num);
  assert.equal(state.game.decks.firstGoal.includes(num), false);
  // The same chip cannot be drawn twice — physically or virtually.
  deposit(state, '9', 2000);
  assert.throws(
    () => buyTicket(state, {
      familyId: '9',
      bettor: 'Lauren',
      picks: { firstGoal: num, firstPenalty: null, playmaker: null },
      mode: 'physical',
    }),
    /already drawn/
  );
  assert.equal(state.game.decks.firstGoal.includes(num), false);
});

test('organizer draw mode: physical locks out virtual, virtual locks out physical, mixed allows both, mode carries across reset', () => {
  const state = fundedGame();
  assert.equal(state.game.drawMode, 'mixed'); // default: parents choose

  // Physical: a virtual ticket is rejected, a real-chip ticket works.
  setDrawMode(state, 'physical');
  assert.equal(state.game.drawMode, 'physical');
  assert.throws(
    () => buyTicket(state, { familyId: '22', bettor: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } }),
    /real chips only/
  );
  const num = state.game.decks.firstGoal[0];
  const t = buyTicket(state, { familyId: '22', bettor: 'Trish', picks: { firstGoal: num, firstPenalty: null, playmaker: null }, mode: 'physical' });
  assert.equal(t.mode, 'physical');

  // Virtual: a real-chip ticket is rejected, a virtual ticket works.
  setDrawMode(state, 'virtual');
  deposit(state, '9', 2000);
  assert.throws(
    () => buyTicket(state, { familyId: '9', bettor: 'Lauren', picks: { firstGoal: state.game.decks.firstGoal[0], firstPenalty: null, playmaker: null }, mode: 'physical' }),
    /virtual draw only/
  );
  const t2 = buyTicket(state, { familyId: '9', bettor: 'Lauren', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  assert.equal(t2.mode, 'virtual');

  // Mixed: both modes work again.
  setDrawMode(state, 'mixed');
  assert.throws(() => setDrawMode(state, 'bogus'), /Unknown draw mode/);
  deposit(state, '16', 2000);
  const num3 = state.game.decks.firstGoal[0];
  const t3 = buyTicket(state, { familyId: '16', bettor: 'Diane', picks: { firstGoal: num3, firstPenalty: null, playmaker: null }, mode: 'physical' });
  assert.equal(t3.mode, 'physical');

  // The mode carries across a reset (organizer changes it, not the reset).
  setDrawMode(state, 'physical');
  const { entry } = resetGame(state);
  assert.equal(entry.drawMode, 'physical');
  assert.equal(state.game.drawMode, 'physical');
});

test('openGame shuffles three full decks and starts pots at the carryover', () => {
  const state = createInitialState();
  setCarryover(state, 'playmaker', 900);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, rng: seededRng(3) });
  assert.equal(state.game.phase, 'open');
  assert.deepEqual(state.game.pots, { firstGoal: 0, firstPenalty: 0, playmaker: 900 });
  // 16 players on the roster (15 families — the two Boyle kids share a wallet).
  // Starting goalie is #29 (Harrison in net): First Goal is 15 (all except
  // Harrison — Luke #88 plays as a skater); the other two decks have all 16.
  assert.equal(state.game.decks.firstGoal.length, 15);
  assert.deepEqual([...state.game.decks.firstGoal].sort((a, b) => a - b),
    [9, 16, 17, 19, 20, 22, 23, 24, 55, 58, 87, 88, 94, 96, 98].sort((a, b) => a - b));
  for (const c of ['firstPenalty', 'playmaker']) {
    assert.equal(state.game.decks[c].length, 16);
    assert.deepEqual([...state.game.decks[c]].sort((a, b) => a - b),
      [9, 16, 17, 19, 20, 22, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98].sort((a, b) => a - b));
  }
  // Decks are shuffled differently from each other.
  assert.notDeepEqual(state.game.decks.firstGoal, state.game.decks.firstPenalty);
});

test('closeDraft stops ticket sales but still allows resolving; reopenDraft restores the draft', () => {
  const state = fundedGame();
  buyFullTicket(state, '22', 'Brandon Pecola');
  closeDraft(state);
  assert.equal(state.game.phase, 'closed');
  // No more tickets once the draft is closed.
  deposit(state, '22', 2000);
  assert.throws(
    () => buyTicket(state, { familyId: '22', buyer: 'Trish Adair', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } }),
    /draft is closed/
  );
  // But the game can still be resolved after it is closed.
  const res = resolveCategory(state, 'firstGoal', state.tickets[0].picks.firstGoal.number);
  assert.equal(res.winners.length, 1);
  // Reopening restores ticket sales.
  reopenDraft(state);
  assert.equal(state.game.phase, 'open');
  buyTicket(state, { familyId: '22', buyer: 'Trish Adair', picks: { firstGoal: 1, firstPenalty: null, playmaker: null } });
  assert.equal(state.tickets.length, 2);
  // Closing twice, or reopening while open, throws.
  closeDraft(state);
  assert.throws(() => closeDraft(state), /No open draft to close/);
  reopenDraft(state);
  assert.throws(() => reopenDraft(state), /not closed/);
  // Closing from setup throws too.
  const fresh = createInitialState();
  assert.throws(() => closeDraft(fresh), /No open draft to close/);
});

test('Decks follow the starting goalie: First Goal excludes only the goalie in net; Harrison is out of everything when backup; Luke plays as a skater when Harrison is in net', () => {
  // Harrison (#29) in net: First Goal is 15 (all except Harrison, Luke #88
  // in as a skater); First Penalty and Playmaker are all 16.
  const h = createInitialState();
  openGame(h, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, rng: seededRng(5) });
  assert.equal(h.game.decks.firstGoal.length, 15);
  assert.ok(!h.game.decks.firstGoal.includes(29));
  assert.ok(h.game.decks.firstGoal.includes(88)); // Luke plays as a skater
  assert.equal(h.game.decks.firstPenalty.length, 16);
  assert.equal(h.game.decks.playmaker.length, 16);
  // A physical pick of Harrison for First Goal is rejected; Luke is fine.
  deposit(h, '22', 2000);
  assert.throws(
    () => buyTicket(h, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: 29, firstPenalty: null, playmaker: null }, mode: 'physical' }),
    /not in the First Goal draw/
  );
  buyTicket(h, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: 88, firstPenalty: null, playmaker: null }, mode: 'physical' });
  assert.throws(() => resolveCategory(h, 'firstGoal', 29), /not in the First Goal draw/);

  // Luke (#88) in net: Harrison is the backup and does not skate out, so he
  // is out of every category. First Goal is the 14 skaters; First Penalty
  // and Playmaker are 15 (14 skaters + Luke).
  const l = createInitialState();
  openGame(l, { gameDate: '2026-11-15', opponent: 'North Pittsburgh', startingGoalie: 88, rng: seededRng(6) });
  assert.equal(l.game.decks.firstGoal.length, 14);
  assert.ok(!l.game.decks.firstGoal.includes(29));
  assert.ok(!l.game.decks.firstGoal.includes(88));
  assert.equal(l.game.decks.firstPenalty.length, 15);
  assert.ok(!l.game.decks.firstPenalty.includes(29));
  assert.ok(l.game.decks.firstPenalty.includes(88));
  assert.equal(l.game.decks.playmaker.length, 15);
  deposit(l, '22', 2000);
  assert.throws(
    () => buyTicket(l, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: null, firstPenalty: 29, playmaker: null }, mode: 'physical' }),
    /not playing this game/
  );

  // rebuildDecks fixes a game opened before the rule changed, keeping drawn cards out.
  const old = createInitialState();
  old.game.decks = {
    firstGoal: [9, 16, 29, 88, 22],
    firstPenalty: [9, 29, 88],
    playmaker: [9, 29, 88],
  };
  old.game.phase = 'open';
  old.game.startingGoalie = 29; // Harrison in net — Luke belongs back in First Goal
  old.tickets = [{ familyId: '22', bettor: 'Brandon Pecola', picks: { firstGoal: { number: 9, name: 'Iannini' }, firstPenalty: null, playmaker: null } }];
  const out = rebuildDecks(old);
  assert.equal(out.firstGoal.after, 14); // 15 in the First Goal pool (all except Harrison) minus drawn #9
  assert.ok(old.game.decks.firstGoal.includes(88));
  assert.ok(!old.game.decks.firstGoal.includes(9)); // already drawn, stays out
  assert.equal(out.firstPenalty.after, 16);
  assert.equal(out.playmaker.after, 16);
});

test('setStartingGoalie: an open game opened with the wrong goalie can be fixed — decks rebuild, sold plays stay, conflicts are reported', () => {
  const state = createInitialState();
  openGame(state, { gameDate: '2026-11-15', opponent: 'North Pittsburgh', startingGoalie: 88, rng: seededRng(11) });
  // Luke picked as goalie: he is out of First Goal, Harrison is out of everything.
  assert.equal(state.game.decks.firstGoal.length, 14);
  assert.equal(state.game.decks.firstPenalty.length, 15);
  assert.ok(!state.game.decks.firstPenalty.includes(29));

  // Sell a play on Luke in First Penalty (he is in there as the "goalie"),
  // then fix the goalie: Luke is really skating out, Harrison is in net.
  deposit(state, '22', 2000);
  const fpIndex = state.game.decks.firstPenalty.indexOf(88);
  buyTicket(state, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: null, firstPenalty: fpIndex, playmaker: null }, mode: 'virtual' });

  const out = setStartingGoalie(state, 29);
  assert.equal(state.game.startingGoalie, 29);
  assert.equal(out.startingGoalie, 29);
  assert.equal(state.game.decks.firstGoal.length, 15); // everyone but Harrison, nothing drawn there
  assert.ok(state.game.decks.firstGoal.includes(88)); // Luke can score now
  assert.equal(state.game.decks.firstPenalty.length, 15); // 16 minus the drawn Luke card
  assert.ok(!state.game.decks.firstPenalty.includes(88)); // sold play's card stays out
  assert.equal(state.game.decks.playmaker.length, 16);
  assert.ok(state.game.decks.playmaker.includes(29)); // Harrison is in as the goalie
  assert.equal(out.conflicts.length, 0); // Luke in First Penalty still fits

  // A sold play that no longer fits is reported, not changed: sell Harrison
  // in First Penalty (he is in as the goalie), then switch the goalie back.
  deposit(state, '19', 2000);
  const hIndex = state.game.decks.firstPenalty.indexOf(29);
  buyTicket(state, { familyId: '19', buyer: 'Cheryl Vrcek', picks: { firstGoal: null, firstPenalty: hIndex, playmaker: null }, mode: 'virtual' });
  const out2 = setStartingGoalie(state, 88);
  assert.equal(out2.conflicts.length, 1);
  assert.equal(out2.conflicts[0].playerNumber, 29);
  assert.equal(out2.conflicts[0].category, 'firstPenalty');
  assert.equal(state.tickets.length, 2); // both plays untouched

  // Not in setup, and only a real goalie.
  const fresh = createInitialState();
  assert.throws(() => setStartingGoalie(fresh, 29), /No game is open/);
  assert.throws(() => setStartingGoalie(state, 22), /#29 or #88/);
});

test('Play now pay later: a ticket goes through on a short wallet and the balance goes negative; the ticket is marked payLater', () => {
  const state = createInitialState();
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, rng: seededRng(7) });
  // Wallet holds $0 — a normal buy is rejected.
  assert.throws(
    () => buyTicket(state, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: 0, firstPenalty: null, playmaker: null }, mode: 'virtual' }),
    /Insufficient wallet balance/
  );
  // Play now pay later goes through and the balance goes negative.
  const ticket = buyTicket(state, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: 0, firstPenalty: null, playmaker: null }, mode: 'virtual', payLater: true });
  assert.equal(ticket.payLater, true);
  assert.equal(state.wallets['22'].balanceCents, -200);
  // A later deposit evens it out.
  deposit(state, '22', 600);
  assert.equal(state.wallets['22'].balanceCents, 400);
});

test('setCarryover works in setup and is rejected once the game is open', () => {
  const state = createInitialState();
  setCarryover(state, 'playmaker', 700);
  assert.equal(state.game.carryover.playmaker, 700);
  assert.equal(state.game.pots.playmaker, 700);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  assert.throws(() => setCarryover(state, 'playmaker', 100), /only be edited while the game is in setup/);
});

// ---------------------------------------------------------------------------
// Resolving and splitting pots
// ---------------------------------------------------------------------------

test('resolve splits the pot equally; odd cents go to the first winners', () => {
  const state = createInitialState();
  for (const n of ['22', '9', '16']) deposit(state, n, 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  // Force the decks so we control who picks whom.
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98];
  buyTicket(state, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  buyTicket(state, { familyId: '9', buyer: 'Lauren', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  buyTicket(state, { familyId: '16', buyer: 'Diane', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  // Pot is $3 (3 tickets x $1). Resolve for Liam #22 — only Trish picked him.
  const res = resolveCategory(state, 'firstGoal', 22);
  assert.equal(res.winners.length, 1);
  assert.equal(res.winners[0].payoutCents, 300);
  assert.equal(res.winners[0].disposition, 'unmarked');
  assert.equal(res.rollover, false);

  // Odd split: a $10 pot split 3 ways -> 334/333/333.
  const state2 = createInitialState();
  for (const n of ['22', '9', '16']) deposit(state2, n, 2000);
  openGame(state2, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  // Make all three buyers draw #22 by re-stacking the deck before each buy.
  state2.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96];
  buyTicket(state2, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  // Make the next two buyers also draw #22 by re-stacking the deck.
  state2.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94];
  buyTicket(state2, { familyId: '9', buyer: 'Lauren', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  state2.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88];
  buyTicket(state2, { familyId: '16', buyer: 'Diane', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  // Pot is $3; add $7 by hand to make a $10 pot, then resolve for #22.
  state2.game.pots.firstGoal = 1000;
  const res2 = resolveCategory(state2, 'firstGoal', 22);
  assert.equal(res2.winners.length, 3);
  assert.deepEqual(res2.winners.map((w) => w.payoutCents), [334, 333, 333]);
  assert.equal(res2.winners.reduce((s, w) => s + w.payoutCents, 0), 1000);
});

test('resolve with no winning tickets marks the pot as a rollover', () => {
  const state = fundedGame();
  buyFullTicket(state, '22', 'Trish');
  const res = resolveCategory(state, 'firstGoal', 98); // nobody picked Beckett
  assert.equal(res.winners.length, 0);
  assert.equal(res.rollover, true);
  assert.equal(res.potCents, 100);
});

test('rollCategory marks a category as a no-winner rollover and the pot carries at reset', () => {
  const state = fundedGame();
  buyFullTicket(state, '22', 'Trish'); // playmaker pot now $1
  const res = rollCategory(state, 'playmaker');
  assert.equal(res.noWinner, true);
  assert.equal(res.playerNumber, null);
  assert.equal(res.winners.length, 0);
  assert.equal(res.potCents, 100);
  const { entry } = resetGame(state);
  assert.equal(entry.rollovers.playmaker, 100);
  assert.equal(state.game.carryover.playmaker, 100);
  assert.equal(entry.resolutions.playmaker.noWinner, true);
});

test('rollCategory refuses once a category has a winning bettor', () => {
  const state = fundedGame();
  const t = buyFullTicket(state, '22', 'Trish');
  resolveCategory(state, 'firstGoal', t.picks.firstGoal.number);
  assert.throws(() => rollCategory(state, 'firstGoal'), /already has a winner/);
});

test('unrollCategory clears a no-winner roll so a player can still be resolved', () => {
  const state = fundedGame();
  const t = buyFullTicket(state, '22', 'Trish');
  rollCategory(state, 'playmaker');
  unrollCategory(state, 'playmaker');
  assert.equal(state.game.resolutions.playmaker, null);
  const res = resolveCategory(state, 'playmaker', t.picks.playmaker.number);
  assert.equal(res.winners.length, 1);
  assert.throws(() => unrollCategory(state, 'playmaker'), /not marked as a no-winner rollover/);
});

test('validateImportEntries keeps a no-winner rollover entry intact', () => {
  const [entry] = validateImportEntries([{
    gameDate: '2026-11-15', opponent: 'North Pittsburgh', startingGoalie: 88,
    pots: { firstGoal: 2200, firstPenalty: 1000, playmaker: 2200 },
    resolutions: {
      playmaker: { playerNumber: null, playerName: null, potCents: 2200, rollover: true, noWinner: true, winners: [] },
    },
  }]);
  assert.equal(entry.resolutions.playmaker.noWinner, true);
  assert.equal(entry.resolutions.playmaker.playerNumber, null);
  assert.equal(entry.resolutions.playmaker.potCents, 2200);
});

test('re-resolving a category changes the winner (wrong kid fix)', () => {
  const state = fundedGame();
  // Make Trish draw #22 for First Goal by re-stacking the deck.
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96];
  buyTicket(state, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  const res1 = resolveCategory(state, 'firstGoal', 22);
  assert.equal(res1.winners.length, 1);
  assert.equal(res1.playerNumber, 22);
  // Organizer picked the wrong kid: change it to #16 (nobody picked him).
  const res2 = resolveCategory(state, 'firstGoal', 16);
  assert.equal(res2.playerNumber, 16);
  assert.equal(res2.winners.length, 0);
  assert.equal(res2.rollover, true);
});

test('re-resolving reverses a rolled credit', () => {
  // wonGame already resolved firstGoal to #22; Trish + Lauren each won $1.
  const { state } = wonGame();
  // Lauren (family '9') rolls her $1 win to her account.
  const laurenWin = state.game.resolutions.firstGoal.winners.find((w) => w.buyer === 'Lauren');
  setPayout(state, 'firstGoal', laurenWin.ticketId, 'rolled');
  assert.equal(state.wallets['9'].balanceCents, 2000 - 200 + 100); // $20 - $2 ticket + $1 win = $19
  // Change the winner to #16 (nobody picked him): Lauren's credit comes back out.
  resolveCategory(state, 'firstGoal', 16);
  assert.equal(state.wallets['9'].balanceCents, 2000 - 200); // back to $18
  assert.equal(state.game.resolutions.firstGoal.winners.length, 0);
});

test('re-resolving refuses when the rolled credit was already spent', () => {
  const { state } = wonGame();
  const laurenWin = state.game.resolutions.firstGoal.winners.find((w) => w.buyer === 'Lauren');
  setPayout(state, 'firstGoal', laurenWin.ticketId, 'rolled');
  // Simulate Lauren spending the credit: wallet drops below her $1 payout.
  state.wallets['9'].balanceCents = 50;
  assert.throws(() => resolveCategory(state, 'firstGoal', 16), /already been spent/);
  // The original resolution is untouched.
  assert.equal(state.game.resolutions.firstGoal.playerNumber, 22);
});

test('resolving a bad player throws', () => {
  const state = fundedGame();
  assert.throws(() => resolveCategory(state, 'firstPenalty', 999), /Unknown player/);
});

// ---------------------------------------------------------------------------
// Payout dispositions: paid vs rolled to account
// ---------------------------------------------------------------------------

function wonGame() {
  // One game: Trish and Lauren both picked Liam #22 for First Goal; $2 pot.
  const state = createInitialState();
  deposit(state, '22', 2000);
  deposit(state, '9', 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  // Make both buyers draw #22 by re-stacking the deck before the second buy.
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96];
  const t1 = buyTicket(state, { familyId: '22', buyer: 'Trish', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94];
  const t2 = buyTicket(state, { familyId: '9', buyer: 'Lauren', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } });
  const res = resolveCategory(state, 'firstGoal', 22);
  assert.equal(res.winners.length, 2);
  assert.deepEqual(res.winners.map((w) => w.payoutCents), [100, 100]);
  return { state, t1, t2, res };
}

test('rolled payout credits the wallet; paid leaves it alone; switching back reverses', () => {
  const { state, t1, t2 } = wonGame();
  // Balances after the $2 ticket: Trish $18.00, Lauren $18.00.
  assert.equal(state.wallets['22'].balanceCents, 1800);
  assert.equal(state.wallets['9'].balanceCents, 1800);

  // Trish rolls her $1 win to her account.
  const w1 = setPayout(state, 'firstGoal', t1.id, 'rolled');
  assert.equal(w1.disposition, 'rolled');
  assert.equal(state.wallets['22'].balanceCents, 1900);

  // Lauren is paid out externally — no wallet change.
  const w2 = setPayout(state, 'firstGoal', t2.id, 'paid');
  assert.equal(w2.disposition, 'paid');
  assert.equal(state.wallets['9'].balanceCents, 1800);

  // Switch Trish back to paid: the $1 credit comes back out.
  setPayout(state, 'firstGoal', t1.id, 'paid');
  assert.equal(state.wallets['22'].balanceCents, 1800);

  // Undo to unmarked from paid: no wallet change.
  setPayout(state, 'firstGoal', t1.id, 'unmarked');
  assert.equal(state.wallets['22'].balanceCents, 1800);
  assert.equal(state.game.resolutions.firstGoal.winners[0].disposition, 'unmarked');
});

test('spent-credit guard: cannot switch rolled back to paid after the credit is spent', () => {
  const { state, t1 } = wonGame();
  setPayout(state, 'firstGoal', t1.id, 'rolled');
  assert.equal(state.wallets['22'].balanceCents, 1900);
  // The family spends the credit (e.g. on a later game's ticket) so the
  // wallet drops below the $1 payout. (Constructed directly here: the
  // one-ticket-per-family rule means this only happens across games.)
  state.wallets['22'].balanceCents = 50;
  assert.throws(
    () => setPayout(state, 'firstGoal', t1.id, 'paid'),
    /already been spent/
  );
  // The disposition stays rolled and the wallet is untouched.
  assert.equal(state.game.resolutions.firstGoal.winners[0].disposition, 'rolled');
  assert.equal(state.wallets['22'].balanceCents, 50);
});

test('setPayout on an unresolved category throws', () => {
  const state = fundedGame();
  assert.throws(() => setPayout(state, 'firstGoal', 't_x', 'paid'), /has not been resolved/);
});

// ---------------------------------------------------------------------------
// Reset, rollover, slush, game log
// ---------------------------------------------------------------------------

test('reset saves the game to the log first; unwon pots roll, won pots start at $0', () => {
  const state = createInitialState();
  deposit(state, '22', 2000);
  deposit(state, '9', 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  // Force the decks so Trish draws #22 for First Goal and nobody draws #98.
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98];
  state.game.decks.firstPenalty = [16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96, 9, 22, 98];
  buyFullTicket(state, '22', 'Trish');
  buyFullTicket(state, '9', 'Lauren');
  // First Goal pot $2, won by Trish (#22). First Penalty pot $2, nobody picked #98.
  // Playmaker pot $2, left undecided.
  resolveCategory(state, 'firstGoal', 22);
  setPayout(state, 'firstGoal', state.tickets[0].id, 'rolled'); // Trish rolls her $2 win
  resolveCategory(state, 'firstPenalty', 98);

  const { logged, entry } = resetGame(state);
  assert.equal(logged, true);
  // Log entry contents.
  assert.equal(entry.gameDate, '2026-11-14');
  assert.equal(entry.opponent, 'Johnstown');
  assert.equal(entry.startingGoalie, 88);
  assert.deepEqual(entry.pots, { firstGoal: 200, firstPenalty: 200, playmaker: 200 });
  assert.equal(entry.tickets.length, 2);
  assert.equal(entry.tickets[0].buyer, 'Trish');
  assert.equal(entry.resolutions.firstGoal.winners[0].disposition, 'rolled');
  assert.equal(entry.resolutions.firstGoal.winners[0].payoutCents, 200);
  assert.deepEqual(entry.rollovers, { firstGoal: 0, firstPenalty: 200, playmaker: 200 });
  assert.equal(entry.slushGameCents, 600);
  assert.equal(entry.slushSeasonCents, 600);

  // Next game: won category $0, rolled categories carry.
  assert.equal(state.game.phase, 'setup');
  assert.deepEqual(state.game.carryover, { firstGoal: 0, firstPenalty: 200, playmaker: 200 });
  assert.deepEqual(state.game.pots, { firstGoal: 0, firstPenalty: 200, playmaker: 200 });
  assert.equal(state.tickets.length, 0);
  // The new game carries NO winners: all three resolutions are null, and no
  // ticket or payout survives — winners live only in the log entry.
  assert.deepEqual(state.game.resolutions, { firstGoal: null, firstPenalty: null, playmaker: null });
  assert.equal(state.game.gameDate, null);
  assert.equal(state.game.opponent, null);
  assert.equal(entry.resolutions.firstGoal.winners[0].buyer, 'Trish');
  // Rolled credit stays in Trish's wallet; slush and log survive.
  assert.equal(state.wallets['22'].balanceCents, 1600); // 2000 - 600 ticket + 200 rolled win
  assert.equal(state.slushCents, 600);
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0], entry);
});

test('slush accumulates across games and is never touched by resets', () => {
  const state = createInitialState();
  deposit(state, '22', 5000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  buyFullTicket(state, '22', 'Trish'); // +$3 slush
  resetGame(state);
  assert.equal(state.slushCents, 300);
  openGame(state, { gameDate: '2026-11-15', opponent: 'North Pittsburgh #2', startingGoalie: 29, rng: seededRng(9) });
  buyFullTicket(state, '22', 'Trish'); // +$3 slush
  resetGame(state);
  assert.equal(state.slushCents, 600);
  assert.equal(state.log.length, 2);
  assert.equal(state.log[0].slushGameCents, 300);
  assert.equal(state.log[0].slushSeasonCents, 600);
  assert.equal(state.log[1].slushSeasonCents, 300);
});

test('payAmanda records the payment and resets the slush owed to $0', () => {
  const state = createInitialState();
  deposit(state, '22', 5000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  buyFullTicket(state, '22', 'Trish'); // +$3 slush
  resetGame(state);
  assert.equal(state.slushCents, 300);
  const out = payAmanda(state);
  assert.equal(out.paidCents, 300);
  assert.ok(out.paidAt);
  assert.equal(state.slushCents, 0);
  assert.equal(state.slushPayments.length, 1);
  assert.equal(state.slushPayments[0].amountCents, 300);
  assert.throws(() => payAmanda(state), /Nothing is owed/);
});

test('after reset, the board-facing state shows no winners at all', () => {
  const state = createInitialState();
  deposit(state, '22', 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  buyFullTicket(state, '22', 'Trish');
  // Resolve First Goal for the player Trish actually drew, so a winner shows.
  resolveCategory(state, 'firstGoal', state.tickets[0].picks.firstGoal.number);
  assert.ok(state.game.resolutions.firstGoal);
  assert.equal(state.game.resolutions.firstGoal.winners.length, 1);

  resetGame(state);

  // After reset: nothing on the board can be mistaken for a winner.
  assert.deepEqual(state.game.resolutions, { firstGoal: null, firstPenalty: null, playmaker: null });
  assert.equal(state.tickets.length, 0);
  assert.equal(state.game.phase, 'setup');
  assert.equal(state.game.gameDate, null);
  assert.equal(state.game.opponent, null);
  // ...but the finished game kept its winner inside its Game Log entry.
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].resolutions.firstGoal.winners.length, 1);
  assert.equal(state.log[0].resolutions.firstGoal.winners[0].buyer, 'Trish');
});

test('reset from setup with no game played logs nothing', () => {
  const state = createInitialState();
  const { logged } = resetGame(state);
  assert.equal(logged, false);
  assert.equal(state.log.length, 0);

  // Setting a carryover by hand and resetting still logs nothing.
  setCarryover(state, 'playmaker', 900);
  const r2 = resetGame(state);
  assert.equal(r2.logged, false);
  assert.equal(state.log.length, 0);
});

test('reset of an opened but unplayed game logs an entry (carryovers preserved)', () => {
  const state = createInitialState();
  setCarryover(state, 'playmaker', 900);
  openGame(state, { gameDate: '2026-11-21', opponent: 'SHAHA Panthers', startingGoalie: 29, rng: seededRng() });
  const { logged, entry } = resetGame(state);
  assert.equal(logged, true);
  assert.deepEqual(entry.rollovers, { firstGoal: 0, firstPenalty: 0, playmaker: 900 });
  assert.equal(state.game.carryover.playmaker, 900);
});

test('factory reset wipes everything back to a clean slate', () => {
  const state = createInitialState();
  deposit(state, '22', 2000);
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  buyFullTicket(state, '22', 'Trish');
  resolveCategory(state, 'firstGoal', 22);
  resetGame(state);
  assert.equal(state.log.length, 1);
  assert.ok(state.slushCents > 0);

  factoryReset(state);
  assert.equal(state.slushCents, 0);
  assert.equal(state.log.length, 0);
  assert.equal(state.tickets.length, 0);
  assert.equal(state.game.phase, 'setup');
  assert.deepEqual(state.game.pots, { firstGoal: 0, firstPenalty: 0, playmaker: 0 });
  assert.deepEqual(state.game.carryover, { firstGoal: 0, firstPenalty: 0, playmaker: 0 });
  for (const w of Object.values(state.wallets)) {
    assert.equal(w.balanceCents, 0);
  }
  assert.equal(Object.keys(state.wallets).length, 15);
});

test('a full season arc: two games, rollovers accumulate, log newest first', () => {
  const state = createInitialState();
  deposit(state, '22', 5000);
  deposit(state, '9', 5000);
  // Game 1: Playmaker undecided two games running -> pot grows.
  openGame(state, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng() });
  state.game.decks.firstGoal = [22, 9, 16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96, 98];
  state.game.decks.firstPenalty = [16, 17, 19, 20, 23, 24, 29, 55, 58, 87, 88, 94, 96, 9, 22, 98];
  buyFullTicket(state, '22', 'Trish');
  buyFullTicket(state, '9', 'Lauren');
  resolveCategory(state, 'firstGoal', 22); // Trish wins $2
  resolveCategory(state, 'firstPenalty', 98); // nobody wins, $2 rolls
  // Playmaker left undecided: $2 rolls.
  resetGame(state);
  assert.deepEqual(state.game.carryover, { firstGoal: 0, firstPenalty: 200, playmaker: 200 });

  openGame(state, { gameDate: '2026-11-15', opponent: 'North Pittsburgh #2', startingGoalie: 29, rng: seededRng(5) });
  buyFullTicket(state, '22', 'Trish');
  buyFullTicket(state, '9', 'Lauren');
  // Playmaker pot is now $2 (carry) + $2 (new tickets) = $4; still undecided.
  assert.equal(state.game.pots.playmaker, 400);
  resetGame(state);
  assert.equal(state.game.carryover.playmaker, 400); // accumulated across games
  assert.equal(state.log.length, 2);
  assert.equal(state.log[0].gameDate, '2026-11-15'); // newest first
  assert.equal(state.log[1].gameDate, '2026-11-14');
  assert.equal(state.slushCents, 1200); // $3/game x 2 games x 2 tickets
});

// ---------------------------------------------------------------------------
// Scratched players (out for a game — sick, hurt, not dressing)
// ---------------------------------------------------------------------------

test('scratched players are out of every deck when the game opens (multiple at once)', () => {
  const s = createInitialState();
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, scratched: [24, 23], rng: seededRng(11) });
  assert.deepEqual(s.game.scratched, [24, 23]);
  // Harrison in net: First Goal pool is 15, the other decks are 16 — minus 2 scratched skaters.
  assert.equal(s.game.decks.firstGoal.length, 13);
  assert.equal(s.game.decks.firstPenalty.length, 14);
  assert.equal(s.game.decks.playmaker.length, 14);
  for (const c of ['firstGoal', 'firstPenalty', 'playmaker']) {
    assert.ok(!s.game.decks[c].includes(24));
    assert.ok(!s.game.decks[c].includes(23));
  }
});

test('setScratched in setup is stored and the decks are built without them at open', () => {
  const s = createInitialState();
  const out = setScratched(s, [20]);
  assert.deepEqual(out.scratched, [20]);
  assert.deepEqual(out.alreadyPicked, []);
  assert.deepEqual(s.game.scratched, [20]);
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, rng: seededRng(12) });
  // Luke in net: First Goal 14 skaters, First Penalty / Playmaker 15 — minus scratched #20.
  assert.equal(s.game.decks.firstGoal.length, 13);
  assert.equal(s.game.decks.firstPenalty.length, 14);
  assert.ok(!s.game.decks.playmaker.includes(20));
});

test('scratching players mid-draft rebuilds the decks, blocks picks and resolving, and flags plays already sold', () => {
  const s = createInitialState();
  deposit(s, '22', 2000);
  deposit(s, '9', 2000);
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, rng: seededRng(13) });
  // Sell a real-chip play on #24 Masula for First Goal.
  buyTicket(s, { familyId: '9', buyer: 'Lauren Iannini', picks: { firstGoal: 24, firstPenalty: null, playmaker: null }, mode: 'physical' });
  // Scratch #24 (already picked) and #17 (not picked).
  const out = setScratched(s, [24, 17]);
  assert.deepEqual(out.alreadyPicked, [24]);
  assert.ok(!s.game.decks.firstGoal.includes(17));
  assert.ok(!s.game.decks.firstPenalty.includes(17));
  assert.ok(!s.game.decks.playmaker.includes(24));
  // The play already sold on #24 stays as it is.
  assert.equal(s.tickets.length, 1);
  assert.equal(s.tickets[0].picks.firstGoal.number, 24);
  // A new real-chip pick of a scratched player is rejected.
  assert.throws(
    () => buyTicket(s, { familyId: '22', buyer: 'Brandon Pecola', picks: { firstGoal: null, firstPenalty: 17, playmaker: null }, mode: 'physical' }),
    /scratched/
  );
  // A scratched player cannot be named the winner.
  assert.throws(() => resolveCategory(s, 'firstPenalty', 17), /scratched/);
  // Clearing the scratches puts the undrawn players back in the decks.
  const cleared = setScratched(s, []);
  assert.deepEqual(cleared.scratched, []);
  assert.ok(s.game.decks.firstPenalty.includes(17));
});

test('a deck-out (-1) draw never returns a scratched player', () => {
  const s = createInitialState();
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, scratched: [24, 23, 17], rng: seededRng(21) });
  s.game.decks.firstGoal = []; // deck exhausted — overflow draws from the in-game pool
  for (let i = 0; i < 40; i++) {
    const t = buyTicket(s, { familyId: '22', bettor: `P${i}`, picks: { firstGoal: -1, firstPenalty: null, playmaker: null }, payLater: true });
    assert.ok(![24, 23, 17].includes(t.picks.firstGoal.number), `scratched player ${t.picks.firstGoal.number} was drawn`);
    assert.notEqual(t.picks.firstGoal.number, 29); // Harrison is out when he is the backup
    assert.notEqual(t.picks.firstGoal.number, 88); // the goalie in net cannot score
  }
});

test('scratches clear on reset — they belong to one game only', () => {
  const s = createInitialState();
  deposit(s, '22', 2000);
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 88, scratched: [24], rng: seededRng(31) });
  buyFullTicket(s, '22', 'Trish');
  resetGame(s);
  assert.deepEqual(s.game.scratched, []);
  assert.equal(s.log[0].scratched[0], 24); // ...but the finished game remembers who was out
});

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

test('backup round-trip: export then restore brings back wallets, slush, the open game and the log', () => {
  const s = createInitialState();
  deposit(s, '22', 2000);
  deposit(s, '9', 500);
  openGame(s, { gameDate: '2026-11-14', opponent: 'Johnstown', startingGoalie: 29, scratched: [24], rng: seededRng(41) });
  buyFullTicket(s, '22', 'Trish');
  const pastGame = {
    id: 'log-1', gameDate: '2026-11-07', opponent: 'SHAHA', startingGoalie: 88,
    tickets: [], resolutions: { firstGoal: null, firstPenalty: null, playmaker: null },
    rollovers: { firstGoal: 0, firstPenalty: 0, playmaker: 0 },
    slushGameCents: 300, slushSeasonCents: 300, endedAt: '2026-11-07T00:00:00.000Z',
  };
  const backup = buildBackup(s, [pastGame]);
  assert.equal(backup.app, 'foxes-slush-fund');

  const fresh = createInitialState();
  const out = applyBackup(fresh, JSON.parse(JSON.stringify(backup)));
  assert.equal(fresh.wallets['22'].balanceCents, 1400); // $20 in, $6 play
  assert.equal(fresh.wallets['9'].balanceCents, 500);
  assert.equal(fresh.slushCents, s.slushCents);
  assert.equal(fresh.game.phase, 'open');
  assert.equal(fresh.game.opponent, 'Johnstown');
  assert.deepEqual(fresh.game.scratched, [24]);
  assert.equal(fresh.tickets.length, 1);
  assert.deepEqual(fresh.game.decks, s.game.decks); // decks restored card-for-card
  assert.equal(out.summary.gamesRestored, 1);
  assert.equal(out.summary.walletsRestored, 15);
  assert.equal(out.logEntries[0].opponent, 'SHAHA');
});

test('applyBackup rejects files that are not Foxes backups and changes nothing', () => {
  const s = createInitialState();
  deposit(s, '22', 700);
  assert.throws(() => applyBackup(s, null), /not a backup/);
  assert.throws(() => applyBackup(s, { app: 'something-else', wallets: {}, log: [], game: {} }), /not a Foxes Slush Fund backup/);
  assert.throws(() => applyBackup(s, { app: 'foxes-slush-fund', wallets: {}, log: [], game: {} }), /no wallets/);
  assert.throws(() => applyBackup(s, { app: 'foxes-slush-fund', wallets: { 22: { balanceCents: 1.5 } }, log: [], game: {} }), /no valid balance/);
  assert.equal(s.wallets['22'].balanceCents, 700); // untouched by the failed restores
});

test('validateImportEntries cleans a dashboard-style game and fills defaults', () => {
  const [e] = validateImportEntries([{
    gameDate: '2026-10-25', opponent: 'New Jersey Colonials', imported: true,
    pots: { firstGoal: 1200, firstPenalty: 1200, playmaker: 12700 },
    resolutions: {
      firstGoal: { playerNumber: 22, potCents: 1200, winners: [{ buyer: 'Cheryl', family: 'Cheryl & Mike', familyId: '19', payoutCents: 1200, disposition: 'paid' }] },
      firstPenalty: null,
      playmaker: { playerNumber: 58, potCents: 12700, winners: [{ buyer: 'Jeffrey', familyId: 58, payoutCents: 12700 }] },
    },
    rollovers: { firstGoal: 0, firstPenalty: 1200, playmaker: 0 },
  }]);
  assert.equal(e.opponent, 'New Jersey Colonials');
  assert.equal(e.startingGoalie, null); // not recorded in the old dashboard
  assert.equal(e.drawMode, 'physical');
  assert.equal(e.resolutions.firstGoal.playerName, 'Liam'); // roster name for #22
  assert.equal(e.resolutions.playmaker.winners[0].familyId, '58'); // stringified
  assert.equal(e.resolutions.playmaker.winners[0].disposition, 'paid'); // default
  assert.equal(e.resolutions.firstPenalty, null);
  assert.equal(e.slushGameCents, 0);
  assert.equal(e.imported, true);
});

test('validateImportEntries rejects malformed games', () => {
  assert.throws(() => validateImportEntries([]), /no games/);
  assert.throws(() => validateImportEntries([{ gameDate: '10/25/2026', opponent: 'X' }]), /bad date/);
  assert.throws(() => validateImportEntries([{ gameDate: '2026-10-25', opponent: 'X', resolutions: { firstGoal: { playerNumber: 999, winners: [] } } }]), /malformed/);
  assert.throws(() => validateImportEntries([{ gameDate: '2026-10-25', opponent: 'X', pots: { firstGoal: -5 } }]), /valid amount/);
});

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test('password hashing: correct password verifies, wrong one does not, hashes differ', () => {
  // NOTE: a throwaway test password — never the real organizer password.
  const h1 = hashPassword('test-organizer-password');
  const h2 = hashPassword('test-organizer-password');
  assert.notEqual(h1, h2, 'salts must differ');
  assert.equal(verifyPassword('test-organizer-password', h1), true);
  assert.equal(verifyPassword('test-organizer-password', h2), true);
  assert.equal(verifyPassword('Test-Organizer-Password', h1), false);
  assert.equal(verifyPassword('wrong', h1), false);
  assert.equal(verifyPassword('test-organizer-password', 'not-a-hash'), false);
  assert.ok(!h1.includes('test-organizer-password'), 'hash must not contain the plaintext password');
});

test('correctSlush sets the owed amount and records the sent total as one payment', () => {
  const state = createInitialState();
  state.slushCents = 300;
  const out = correctSlush(state, { owedCents: 3600, sentCents: 41400, sentAt: '2026-10-26T23:59:59.000Z' });
  assert.equal(state.slushCents, 3600);
  assert.deepEqual(state.slushPayments, [{ amountCents: 41400, paidAt: '2026-10-26T23:59:59.000Z' }]);
  assert.deepEqual(out, { slushCents: 3600, sentCents: 41400 });
});

test('correctSlush with nothing sent clears the payment history', () => {
  const state = createInitialState();
  state.slushPayments = [{ amountCents: 500, paidAt: '2026-01-01T00:00:00.000Z' }];
  correctSlush(state, { owedCents: 0, sentCents: 0 });
  assert.equal(state.slushCents, 0);
  assert.deepEqual(state.slushPayments, []);
});

test('correctSlush rejects negative or fractional amounts', () => {
  const state = createInitialState();
  assert.throws(() => correctSlush(state, { owedCents: -1, sentCents: 0 }), /whole number of cents/);
  assert.throws(() => correctSlush(state, { owedCents: 0, sentCents: 10.5 }), /whole number of cents/);
});

test('logFixDelta moves the payout in and out of the wallet on a flip', () => {
  const winner = { buyer: 'Jeffrey', familyId: '58', payoutCents: 1200, disposition: 'paid' };
  assert.equal(logFixDelta(winner, 'rolled'), 1200);
  assert.equal(logFixDelta({ ...winner, disposition: 'rolled' }, 'paid'), -1200);
  assert.equal(logFixDelta(winner, 'paid'), 0);
});

test('logFixDelta is 0 for a rolled-over pot or a missing winner', () => {
  assert.equal(logFixDelta(null, 'rolled'), 0);
  assert.equal(logFixDelta({ buyer: null, familyId: null, payoutCents: 1200, disposition: 'rolled' }, 'paid'), 0);
  assert.throws(() => logFixDelta({ buyer: 'X', familyId: '58', payoutCents: 100, disposition: 'paid' }, 'unmarked'), /paid.*rolled/);
});

test('setWalletBalances sets exact balances, including negatives, in one pass', () => {
  const state = createInitialState();
  const out = setWalletBalances(state, { '58': 2000, '9': -1500, '23': 0 });
  assert.equal(out.updated, 3);
  assert.equal(state.wallets['58'].balanceCents, 2000);
  assert.equal(state.wallets['9'].balanceCents, -1500);
  assert.equal(state.wallets['23'].balanceCents, 0);
});

test('setWalletBalances validates everything before changing anything', () => {
  const state = createInitialState();
  state.wallets['58'].balanceCents = 1400;
  assert.throws(() => setWalletBalances(state, { '58': 2000, nope: 100 }), /Unknown family/);
  assert.equal(state.wallets['58'].balanceCents, 1400);
  assert.throws(() => setWalletBalances(state, { '58': 10.5 }), /whole number of cents/);
  assert.throws(() => setWalletBalances(state, {}), /No balances/);
});

// ---------------------------------------------------------------------------
// Voiding a game (reset with refunds)
// ---------------------------------------------------------------------------

test('voidGame refunds every play, backs the slush out, keeps the rolled pots', () => {
  const state = createInitialState();
  setCarryover(state, 'firstGoal', 1200); // $12 rolled in from the last game
  deposit(state, '22', 2000);
  deposit(state, '17', 2000);
  openGame(state, { gameDate: '2026-11-15', opponent: 'North Pittsburgh', startingGoalie: 88, rng: seededRng() });
  buyFullTicket(state, '22', 'Trish'); // $6
  buyTicket(state, { familyId: '17', buyer: 'Travis', picks: { firstGoal: 0, firstPenalty: null, playmaker: null } }); // $2
  assert.equal(state.wallets['22'].balanceCents, 1400);
  assert.equal(state.wallets['17'].balanceCents, 1800);
  assert.equal(state.slushCents, 400);
  const r = voidGame(state);
  assert.equal(r.plays, 2);
  assert.equal(r.refundedCents, 800);
  assert.equal(state.wallets['22'].balanceCents, 2000);
  assert.equal(state.wallets['17'].balanceCents, 2000);
  assert.equal(state.slushCents, 0);
  assert.equal(state.tickets.length, 0);
  assert.equal(state.game.phase, 'setup');
  assert.equal(state.game.carryover.firstGoal, 1200);
  assert.equal(state.game.pots.firstGoal, 1200);
  assert.equal(state.log.length, 0);
});

test('voidGame refuses once a winner has been picked', () => {
  const state = fundedGame();
  const t = buyFullTicket(state, '22', 'Trish');
  resolveCategory(state, 'firstGoal', t.picks.firstGoal.number);
  assert.throws(() => voidGame(state), /already been picked/);
});

test('setGamesLeft stores the count for the season projection and validates it', () => {
  const state = createInitialState();
  assert.equal(state.gamesLeft, null);
  assert.equal(setGamesLeft(state, 24), 24);
  assert.equal(state.gamesLeft, 24);
  assert.equal(setGamesLeft(state, 0), 0);
  assert.throws(() => setGamesLeft(state, -1), /whole number/);
  assert.throws(() => setGamesLeft(state, 2.5), /whole number/);
  assert.throws(() => setGamesLeft(state, 81), /whole number/);
  assert.throws(() => setGamesLeft(state, '24'), /whole number/);
});

test('gamesLeft survives a backup round-trip and clears on factory reset', () => {
  const state = createInitialState();
  setGamesLeft(state, 24);
  const backup = buildBackup(state, []);
  assert.equal(backup.gamesLeft, 24);
  const restored = createInitialState();
  applyBackup(restored, backup);
  assert.equal(restored.gamesLeft, 24);
  factoryReset(restored);
  assert.equal(restored.gamesLeft, null);
});

test('resetGame counts the projection games-left down as games are logged', () => {
  const state = fundedGame();
  setGamesLeft(state, 24);
  buyFullTicket(state, '22', 'Trish');
  const r = resetGame(state);
  assert.equal(r.logged, true);
  assert.equal(state.gamesLeft, 23);
});

test('gamesLeft countdown floors at zero and leaves an unset count alone', () => {
  const a = fundedGame();
  setGamesLeft(a, 0);
  buyFullTicket(a, '22', 'Trish');
  resetGame(a);
  assert.equal(a.gamesLeft, 0);
  const b = fundedGame();
  buyFullTicket(b, '22', 'Trish');
  resetGame(b);
  assert.equal(b.gamesLeft, null);
});
