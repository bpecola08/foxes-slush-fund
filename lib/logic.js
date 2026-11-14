// Pure money / game logic for the Foxes Slush Fund Draft app.
// This module has NO Firebase dependencies so it can be unit-tested with plain Node.
// All amounts are integer cents.
//
// Money rules (must match the locked Muse version):
// - A ticket costs $2 per category ($6 for all three). Of each $2, $1 goes to that
//   category's pot and $1 goes to the slush.
// - The slush is a SEASON total owed to Amanda Beckett; it is never touched by resets.
// - Resolving a category: winners are the tickets that picked the resolved player.
//   The pot splits equally among winning tickets (remainder cents go to the first
//   winners, in ticket order).
// - A category with no winning tickets (nobody picked the winner, or left undecided)
//   rolls its FULL pot into the next game automatically. Won categories start at $0.
// - Per winner the organizer marks a payout disposition:
//     'unmarked' (default), 'paid' (paid out externally, no wallet change),
//     'rolled'   (payout credited to the family's wallet as credit for future tickets).
//   Switching rolled -> paid (or rolled -> unmarked) reverses the wallet credit.
//   Server-side guard: refusing rolled -> paid/unmarked when the family has since
//   spent the credit (wallet balance below the payout) with an explanatory error.
// - Reset: saves the finished game to the Game Log FIRST, then clears tickets /
//   pots / resolutions and returns to setup. Carryovers, slush, wallets and the log
//   survive. A reset from setup with no game played logs nothing.
// - Factory reset: wipes everything back to a clean slate (wallets $0, slush $0,
//   log empty). The organizer password lives outside this state and survives.

const CATEGORIES = ['firstGoal', 'firstPenalty', 'playmaker'];
const CATEGORY_LABELS = {
  firstGoal: 'First Goal',
  firstPenalty: 'First Penalty',
  playmaker: 'Playmaker',
};
const TICKET_PRICE_PER_CATEGORY_CENTS = 200; // $2
const POT_SHARE_PER_CATEGORY_CENTS = 100; // $1 to the pot
const SLUSH_SHARE_PER_CATEGORY_CENTS = 100; // $1 to the slush
const GOALIES = [29, 88];

// Roster: 15 players. Each family wallet is unlocked by its kid's jersey number.
const ROSTER = [
  { number: 9, name: 'Iannini', family: 'Lauren & Tim', familyLabel: 'Lauren, Tim & Grandparents' },
  { number: 16, name: 'Keller', family: 'Diane & Brian', familyLabel: 'Diane, Brian & Grandparents' },
  { number: 17, name: 'Stanczyk', family: 'Kaley & Travis', familyLabel: 'Kaley, Travis & Grandparents' },
  { number: 19, name: 'Vrcek', family: 'Cheryl & Mike', familyLabel: 'Cheryl, Mike & Grandparents' },
  { number: 20, name: 'Heichel', family: 'David & Kayla', familyLabel: 'David, Kayla & Grandparents' },
  { number: 22, name: 'Liam', family: 'Trish Adair & Brandon Pecola', familyLabel: 'Trish, Brandon Pecola & Grandparents' },
  { number: 23, name: 'Mohammed', family: 'Sarah Setcavage', familyLabel: 'Sarah & Grandparents' },
  { number: 24, name: 'Masula', family: 'Erin & Michael', familyLabel: 'Erin, Michael & Grandparents' },
  { number: 29, name: 'H. Boyle', family: 'Lauren & Chris Boyle', familyLabel: 'Lauren, Chris & Grandparents' },
  { number: 55, name: 'Peters', family: 'Allie & Jeff', familyLabel: 'Allie, Jeff & Grandparents' },
  { number: 58, name: 'Beatty', family: 'Kahla & Jeffrey', familyLabel: 'Kahla, Jeffrey & Grandparents' },
  { number: 87, name: 'T. Boyle', family: 'Lauren & Chris Boyle', familyLabel: 'Lauren, Chris & Grandparents' },
  { number: 88, name: 'Ifft', family: 'Kari & Ben', familyLabel: 'Kari, Ben & Grandparents' },
  { number: 94, name: 'Freshwater', family: 'Katlin & Brent', familyLabel: 'Katlin, Brent & Grandparents' },
  { number: 96, name: 'Olszewski', family: 'Jason Gordon', familyLabel: 'Jason Gordon & Grandparents' },
  { number: 98, name: 'Beckett', family: 'Amanda & Brad', familyLabel: 'Amanda, Brad & Grandparents' },
];

const ROSTER_BY_NUMBER = Object.fromEntries(ROSTER.map((p) => [p.number, p]));

// Family id = the kid's jersey number (the wallet PIN). The two Boyle kids share
// one family wallet (Lauren & Chris Boyle) keyed under both 29 and 87.
function familyIdForNumber(number) {
  return String(number);
}

function emptyPots() {
  return { firstGoal: 0, firstPenalty: 0, playmaker: 0 };
}

function emptyResolutions() {
  return { firstGoal: null, firstPenalty: null, playmaker: null };
}

function emptyDecks() {
  return { firstGoal: [], firstPenalty: [], playmaker: [] };
}

function createInitialState() {
  // One wallet per FAMILY (15 families for 16 roster players — the two Boyle
  // kids share one wallet). The wallet id is the family's first jersey
  // number; every kid's number in the family unlocks it (codes).
  const wallets = {};
  for (const p of ROSTER) {
    if (Object.values(wallets).some((w) => w.family === p.family)) continue;
    const id = String(p.number);
    wallets[id] = {
      familyId: id,
      family: p.family,
      familyLabel: p.familyLabel,
      codes: ROSTER.filter((q) => q.family === p.family).map((q) => q.number),
      balanceCents: 0,
    };
  }
  return {
    wallets,
    game: {
      phase: 'setup', // 'setup' | 'open'
      gameDate: null,
      opponent: null,
      startingGoalie: null,
      pots: emptyPots(),
      carryover: emptyPots(),
      startingPots: emptyPots(),
      resolutions: emptyResolutions(),
      decks: emptyDecks(),
      slushGameCents: 0,
    },
    tickets: [], // tickets for the CURRENT game only
    slushCents: 0, // season total owed to Amanda Beckett
    slushPayments: [], // payments sent to Amanda Beckett
    log: [], // newest first
  };
}

function assertIntCents(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents`);
  }
}

function walletFor(state, familyId) {
  const key = String(familyId);
  if (state.wallets[key]) return state.wallets[key];
  // Accept a jersey number (PIN) as well: find the wallet whose codes include it.
  const byCode = Object.values(state.wallets).find((w) => w.codes.includes(Number(key)));
  if (byCode) return byCode;
  throw new Error(`Unknown family wallet: ${familyId}`);
}

function shuffle(array, rng = Math.random) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Organizer: game setup
// ---------------------------------------------------------------------------

function setGameInfo(state, { gameDate, opponent }) {
  if (gameDate !== undefined) {
    if (gameDate !== null && typeof gameDate !== 'string') {
      throw new Error('gameDate must be a YYYY-MM-DD string or null');
    }
    state.game.gameDate = gameDate;
  }
  if (opponent !== undefined) {
    if (opponent !== null && typeof opponent !== 'string') {
      throw new Error('opponent must be a string or null');
    }
    state.game.opponent = opponent;
  }
  return state.game;
}

// Set the starting pot (opening jackpot) for a category while in setup.
// This is how a real rolled-over amount (e.g. a Playmaker pot undecided for
// ~7 games) is entered by hand. Also updates the displayed setup pots.
function setCarryover(state, category, amountCents) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  assertIntCents(amountCents, 'Carryover amount');
  if (state.game.phase !== 'setup') {
    throw new Error('Starting pots can only be edited while the game is in setup');
  }
  state.game.carryover[category] = amountCents;
  state.game.pots[category] = amountCents;
  state.game.startingPots[category] = amountCents;
  return state.game;
}

// Step 4 of Start a New Game: lock the roster, shuffle the three decks
// server-side, open the draft. Pots start at the carryover amounts.
function openGame(state, { gameDate, opponent, startingGoalie, rng } = {}) {
  if (state.game.phase !== 'setup') {
    throw new Error('A game is already open');
  }
  if (startingGoalie !== undefined && startingGoalie !== null && !GOALIES.includes(startingGoalie)) {
    throw new Error('Starting goalie must be #29 or #88');
  }
  if (gameDate !== undefined) state.game.gameDate = gameDate;
  if (opponent !== undefined) state.game.opponent = opponent;
  if (startingGoalie !== undefined) state.game.startingGoalie = startingGoalie;

  const numbers = ROSTER.map((p) => p.number);
  state.game.decks = {
    firstGoal: shuffle(numbers, rng),
    firstPenalty: shuffle(numbers, rng),
    playmaker: shuffle(numbers, rng),
  };
  state.game.startingPots = { ...state.game.carryover };
  state.game.pots = { ...state.game.carryover };
  state.game.resolutions = emptyResolutions();
  state.game.slushGameCents = 0;
  state.tickets = [];
  state.game.phase = 'open';
  return state.game;
}

// ---------------------------------------------------------------------------
// Parents: deposits and tickets
// ---------------------------------------------------------------------------

function deposit(state, familyId, amountCents) {
  assertIntCents(amountCents, 'Deposit amount');
  if (amountCents <= 0) throw new Error('Deposit amount must be greater than $0');
  const w = walletFor(state, familyId);
  w.balanceCents += amountCents;
  return w.balanceCents;
}

// picks: { firstGoal: deckIndex|null, firstPenalty: deckIndex|null, playmaker: deckIndex|null }
// The parent taps one face-down card per category; the server reveals the player
// at that deck position and removes the card from the deck. The client never
// sees the deck order, so nobody can cherry-pick a player.
function buyTicket(state, { familyId, buyer, bettor, picks }) {
  if (state.game.phase !== 'open') {
    throw new Error('No game is open — the draft is closed');
  }
  const wallet = walletFor(state, familyId);
  // Who is placing this bet? One ticket per person per game — several people
  // in the same family may each buy their own ticket from the shared wallet.
  const bettorName = String(bettor || buyer || wallet.family || '').trim();
  if (!bettorName) throw new Error('Pick who is betting first');
  if (state.tickets.some((t) => t.familyId === String(familyId) && (t.bettor || t.buyer) === bettorName)) {
    throw new Error(`${bettorName} already has a ticket for this game`);
  }
  const selected = CATEGORIES.filter((c) => picks && picks[c] !== null && picks[c] !== undefined);
  if (selected.length === 0) {
    throw new Error('Pick at least one category');
  }
  const priceCents = selected.length * TICKET_PRICE_PER_CATEGORY_CENTS;
  if (wallet.balanceCents < priceCents) {
    throw new Error(
      `Insufficient wallet balance: ticket costs $${(priceCents / 100).toFixed(2)} ` +
        `but the wallet holds $${(wallet.balanceCents / 100).toFixed(2)}`
    );
  }

  // Validate deck positions before touching any money.
  // picks[c] === -1 means that category's deck is out — draw any player.
  const drawn = {};
  for (const c of selected) {
    const idx = picks[c];
    if (idx === -1) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= state.game.decks[c].length) {
      throw new Error(`That ${CATEGORY_LABELS[c]} card is no longer available — pick another`);
    }
  }
  // Draw (remove from deck, in deck order per category).
  for (const c of selected) {
    if (picks[c] === -1) {
      const player = ROSTER[Math.floor(Math.random() * ROSTER.length)];
      drawn[c] = { name: player.name, number: player.number };
    } else {
      const number = state.game.decks[c].splice(picks[c], 1)[0];
      const player = ROSTER_BY_NUMBER[number];
      drawn[c] = { name: player.name, number: player.number };
    }
  }
  for (const c of CATEGORIES) {
    if (!drawn[c]) drawn[c] = null;
  }

  wallet.balanceCents -= priceCents;
  for (const c of selected) {
    state.game.pots[c] += POT_SHARE_PER_CATEGORY_CENTS;
    state.game.slushGameCents += SLUSH_SHARE_PER_CATEGORY_CENTS;
    state.slushCents += SLUSH_SHARE_PER_CATEGORY_CENTS;
  }

  const ticket = {
    id: `t_${Date.now().toString(36)}_${state.tickets.length + 1}`,
    familyId: String(familyId),
    family: wallet.family,
    familyLabel: wallet.familyLabel,
    buyer: bettorName,
    bettor: bettorName,
    paidCents: priceCents,
    picks: drawn,
  };
  state.tickets.push(ticket);
  return ticket;
}

// ---------------------------------------------------------------------------
// Organizer: resolving categories and payouts
// ---------------------------------------------------------------------------

function resolveCategory(state, category, playerNumber) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  if (state.game.phase !== 'open') {
    throw new Error('No game is open to resolve');
  }
  if (state.game.resolutions[category]) {
    throw new Error(`${CATEGORY_LABELS[category]} has already been resolved`);
  }
  const player = ROSTER_BY_NUMBER[playerNumber];
  if (!player) throw new Error(`Unknown player number: ${playerNumber}`);

  const potCents = state.game.pots[category];
  const winningTickets = state.tickets.filter(
    (t) => t.picks[category] && t.picks[category].number === playerNumber
  );

  let winners = [];
  if (winningTickets.length > 0) {
    // Split the pot equally; remainder cents go to the first winners, in ticket order.
    const base = Math.floor(potCents / winningTickets.length);
    const remainder = potCents - base * winningTickets.length;
    winners = winningTickets.map((t, i) => ({
      ticketId: t.id,
      buyer: t.buyer,
      family: t.family,
      familyId: t.familyId,
      payoutCents: base + (i < remainder ? 1 : 0),
      disposition: 'unmarked', // 'unmarked' | 'paid' | 'rolled'
    }));
  }

  state.game.resolutions[category] = {
    playerName: player.name,
    playerNumber: player.number,
    potCents,
    rollover: winners.length === 0,
    winners,
  };
  return state.game.resolutions[category];
}

// Mark a winner as paid out or rolled to their family account.
// - 'rolled': payout is credited to the family's wallet.
// - 'paid':   paid out externally; no wallet change.
// - 'unmarked': undo the choice.
// Switching away from 'rolled' reverses the wallet credit. If the family has
// since spent the credit (wallet below the payout), the switch is refused.
function setPayout(state, category, ticketId, disposition) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  if (!['paid', 'rolled', 'unmarked'].includes(disposition)) {
    throw new Error(`Unknown payout disposition: ${disposition}`);
  }
  const resolution = state.game.resolutions[category];
  if (!resolution) throw new Error(`${CATEGORY_LABELS[category]} has not been resolved yet`);
  const winner = resolution.winners.find((w) => w.ticketId === ticketId);
  if (!winner) throw new Error(`No winning ticket ${ticketId} in ${CATEGORY_LABELS[category]}`);

  const wallet = walletFor(state, winner.familyId);
  const wasRolled = winner.disposition === 'rolled';
  const willRoll = disposition === 'rolled';

  if (wasRolled && !willRoll) {
    // Reversing a roll: the credit must still be in the wallet.
    if (wallet.balanceCents < winner.payoutCents) {
      throw new Error(
        `Cannot switch ${winner.buyer} back to "${disposition}": their $${(winner.payoutCents / 100).toFixed(2)} ` +
          `rollover credit has already been spent (wallet balance $${(wallet.balanceCents / 100).toFixed(2)}). ` +
          `Add funds to the wallet first, or leave it as rolled to account.`
      );
    }
    wallet.balanceCents -= winner.payoutCents;
  } else if (!wasRolled && willRoll) {
    wallet.balanceCents += winner.payoutCents;
  }
  winner.disposition = disposition;
  return winner;
}

// ---------------------------------------------------------------------------
// Reset and factory reset
// ---------------------------------------------------------------------------

function buildLogEntry(state) {
  const rollovers = {};
  for (const c of CATEGORIES) {
    const res = state.game.resolutions[c];
    if (!res) {
      // Left undecided: the full pot rolls over.
      rollovers[c] = state.game.pots[c];
    } else if (res.winners.length === 0) {
      rollovers[c] = res.potCents;
    } else {
      rollovers[c] = 0;
    }
  }
  return {
    gameDate: state.game.gameDate,
    opponent: state.game.opponent,
    startingGoalie: state.game.startingGoalie,
    pots: { ...state.game.pots },
    startingPots: { ...state.game.startingPots },
    tickets: state.tickets.map((t) => ({ ...t, picks: { ...t.picks } })),
    resolutions: JSON.parse(JSON.stringify(state.game.resolutions)),
    rollovers,
    slushGameCents: state.game.slushGameCents,
    slushSeasonCents: state.slushCents,
    endedAt: new Date().toISOString(),
  };
}

function resetGame(state) {
  const playedAnything =
    state.tickets.length > 0 ||
    CATEGORIES.some((c) => state.game.resolutions[c] !== null) ||
    state.game.slushGameCents > 0 ||
    CATEGORIES.some((c) => state.game.pots[c] !== state.game.carryover[c]);

  if (state.game.phase === 'setup' && !playedAnything) {
    // Reset from setup with no game played logs nothing.
    return { logged: false, entry: null };
  }

  const entry = buildLogEntry(state);
  state.log.unshift(entry); // newest first

  // Next game's starting pots: rolled-over pots carry, won categories start at $0.
  const nextCarryover = { ...entry.rollovers };
  state.game = {
    phase: 'setup',
    gameDate: null,
    opponent: null,
    startingGoalie: null,
    pots: { ...nextCarryover },
    carryover: { ...nextCarryover },
    startingPots: { ...nextCarryover },
    resolutions: emptyResolutions(),
    decks: emptyDecks(),
    slushGameCents: 0,
  };
  state.tickets = [];
  // slushCents (season total), wallets and log survive.
  return { logged: true, entry };
}

// Record that the season slush total was sent to Amanda Beckett: returns
// the payment and resets the amount owed to $0.
function payAmanda(state) {
  const owed = state.slushCents || 0;
  if (owed <= 0) throw new Error('Nothing is owed to Amanda right now.');
  const paidAt = new Date().toISOString();
  if (!Array.isArray(state.slushPayments)) state.slushPayments = [];
  state.slushPayments.unshift({ amountCents: owed, paidAt });
  state.slushCents = 0;
  return { paidCents: owed, paidAt };
}

function factoryReset(state) {
  const fresh = createInitialState();
  state.wallets = fresh.wallets;
  state.game = fresh.game;
  state.tickets = fresh.tickets;
  state.slushCents = 0;
  state.slushPayments = [];
  state.log = [];
  return state;
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  ROSTER,
  ROSTER_BY_NUMBER,
  GOALIES,
  TICKET_PRICE_PER_CATEGORY_CENTS,
  POT_SHARE_PER_CATEGORY_CENTS,
  SLUSH_SHARE_PER_CATEGORY_CENTS,
  createInitialState,
  familyIdForNumber,
  setGameInfo,
  setCarryover,
  openGame,
  deposit,
  buyTicket,
  resolveCategory,
  setPayout,
  resetGame,
  payAmanda,
  factoryReset,
  shuffle,
};
