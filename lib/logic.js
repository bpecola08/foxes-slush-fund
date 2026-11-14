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
// Draw mode for a game — set by the organizer in the Organizer Page.
// 'mixed'    = each parent picks virtual or real chips per ticket (default)
// 'virtual'  = virtual draw only (the app's face-down cards)
// 'physical' = real chips only (draw from the bag, tap the player you got)
const DRAW_MODES = ['mixed', 'virtual', 'physical'];
const DRAW_MODE_LABELS = {
  mixed: 'Let parents choose',
  virtual: 'Virtual draw',
  physical: 'Real chips',
};

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

// Skaters only (both goalies out) — kept for reference; the decks are built
// by buildDecks from the starting goalie (Luke plays as a skater when
// Harrison is in net, Harrison is out when he is the backup).
const SKATERS = ROSTER.filter((p) => !GOALIES.includes(p.number));

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
      phase: 'setup', // 'setup' | 'open' | 'closed'
      gameDate: null,
      opponent: null,
      startingGoalie: null,
      drawMode: 'mixed', // 'mixed' | 'virtual' | 'physical' — set by the organizer
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

// The organizer picks how this game's draft is run: virtual draw, real chips,
// or let each parent choose. Can be changed any time (setup or open); the
// mode carries to the next game until the organizer changes it again.
function setDrawMode(state, mode) {
  if (!DRAW_MODES.includes(mode)) throw new Error(`Unknown draw mode: ${mode}`);
  state.game.drawMode = mode;
  return state.game;
}

// Build the three decks for a game, from who is actually playing.
// The starting goalie (in net) cannot score, so he is out of First Goal
// only — he is still in First Penalty and Playmaker. Harrison (#29) does
// not skate out, so when he is the backup he is out of every category.
// Luke (#88) plays as a skater when Harrison is in net, so he is in all
// three categories then. Everyone else is a skater, in every category.
function buildDecks(startingGoalie, rng) {
  const inGame = ROSTER.filter((p) => {
    if (p.number === startingGoalie) return true; // starting goalie plays (in net)
    if (p.number === 29) return false; // Harrison is out when he is the backup
    return true; // everyone else, including Luke as a skater when backup
  });
  const firstGoalPool = inGame.filter((p) => p.number !== startingGoalie);
  return {
    firstGoal: shuffle(firstGoalPool.map((p) => p.number), rng),
    firstPenalty: shuffle(inGame.map((p) => p.number), rng),
    playmaker: shuffle(inGame.map((p) => p.number), rng),
  };
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

  state.game.decks = buildDecks(state.game.startingGoalie, rng);
  state.game.startingPots = { ...state.game.carryover };
  state.game.pots = { ...state.game.carryover };
  state.game.resolutions = emptyResolutions();
  state.game.slushGameCents = 0;
  state.tickets = [];
  state.game.phase = 'open';
  return state.game;
}

// Close the draft once the real game starts: no more tickets can be bought,
// but the game is still in progress, so the organizer can still resolve it.
function closeDraft(state) {
  if (state.game.phase !== 'open') {
    throw new Error('No open draft to close');
  }
  state.game.phase = 'closed';
  return state.game;
}

// Reopen the draft if it was closed early by mistake.
function reopenDraft(state) {
  if (state.game.phase !== 'closed') {
    throw new Error('The draft is not closed');
  }
  state.game.phase = 'open';
  return state.game;
}

// One-time fix for a game opened before a deck rule changed: rebuild all
// three decks from the current starting goalie, keeping any cards already
// drawn by sold tickets out of the deck.
function rebuildDecks(state) {
  if (state.game.phase !== 'open' && state.game.phase !== 'closed') {
    throw new Error('No game is open to fix');
  }
  const fresh = buildDecks(state.game.startingGoalie, Math.random);
  const out = {};
  for (const c of CATEGORIES) {
    const drawn = new Set(
      (state.tickets || []).map((t) => t.picks?.[c]?.number).filter((n) => n != null)
    );
    const before = state.game.decks[c].length;
    state.game.decks[c] = fresh[c].filter((n) => !drawn.has(n));
    out[c] = { before, after: state.game.decks[c].length };
  }
  return out;
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
// payLater: the parent chose "Play now pay later" — the ticket goes through
// even if the wallet is short, and the wallet balance goes negative until
// the organizer records a deposit.
function buyTicket(state, { familyId, buyer, bettor, picks, mode, payLater }) {
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
  if (!payLater && wallet.balanceCents < priceCents) {
    throw new Error(
      `Insufficient wallet balance: ticket costs $${(priceCents / 100).toFixed(2)} ` +
        `but the wallet holds $${(wallet.balanceCents / 100).toFixed(2)}`
    );
  }

  // The organizer may have locked the game to one draw method.
  const gameDrawMode = state.game.drawMode || 'mixed';
  const physical = mode === 'physical';
  if (gameDrawMode === 'physical' && !physical) {
    throw new Error('This game uses real chips only — draw a chip from the bag.');
  }
  if (gameDrawMode === 'virtual' && physical) {
    throw new Error('This game uses the virtual draw only — tap the cards in the app.');
  }
  // Validate picks before touching any money.
  // Virtual: picks[c] is a DECK POSITION (index into the shuffled deck);
  //   -1 means that category's deck is out — draw any player.
  // Physical (real chip): picks[c] is the PLAYER NUMBER the bettor drew
  //   from the bag. One shared deck backs both modes, so a player already
  //   drawn (virtually or physically) is gone from the bag.
  const drawn = {};
  for (const c of selected) {
    const pick = picks[c];
    if (!physical && pick === -1) continue;
    if (physical) {
      if (!ROSTER_BY_NUMBER[pick]) {
        throw new Error(`Unknown player number: ${pick}`);
      }
      // First Goal: the goalie in net cannot score, and Harrison does not
      // skate out, so he is out when he is the backup. Luke plays as a
      // skater when Harrison is in net, so he is in.
      if (c === 'firstGoal' && (pick === state.game.startingGoalie || (pick === 29 && state.game.startingGoalie !== 29))) {
        throw new Error('That player is not in the First Goal draw — draw another chip');
      }
      // Harrison does not skate out, so when he is the backup he is out of
      // every category.
      if (c !== 'firstGoal' && pick === 29 && state.game.startingGoalie !== 29) {
        throw new Error('Harrison is not playing this game — draw another chip');
      }
      if (!state.game.decks[c].includes(pick)) {
        throw new Error(`That ${CATEGORY_LABELS[c]} player was already drawn — draw another chip`);
      }
    } else if (!Number.isInteger(pick) || pick < 0 || pick >= state.game.decks[c].length) {
      throw new Error(`That ${CATEGORY_LABELS[c]} card is no longer available — pick another`);
    }
  }
  // Draw (remove from deck, in deck order per category).
  for (const c of selected) {
    if (!physical && picks[c] === -1) {
      // Deck is out — draw any player who is in the game. First Goal draws
      // from everyone except the goalie in net (and Harrison when he is the
      // backup); the other categories draw from everyone in the game.
      const inGame = ROSTER.filter((p) => {
        if (p.number === state.game.startingGoalie) return true;
        if (p.number === 29) return false; // Harrison is out when he is the backup
        return true;
      });
      const pool = c === 'firstGoal'
        ? inGame.filter((p) => p.number !== state.game.startingGoalie)
        : inGame;
      const player = pool[Math.floor(Math.random() * pool.length)];
      drawn[c] = { name: player.name, number: player.number };
    } else if (physical) {
      const idx = state.game.decks[c].indexOf(picks[c]);
      const number = state.game.decks[c].splice(idx, 1)[0];
      const player = ROSTER_BY_NUMBER[number];
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
    mode: physical ? 'physical' : 'virtual',
    payLater: Boolean(payLater),
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
  // Resolving is allowed while the draft is open and after it is closed
  // (the game has started but is not over yet) — just not in setup.
  if (state.game.phase !== 'open' && state.game.phase !== 'closed') {
    throw new Error('No game is open to resolve');
  }
  const existing = state.game.resolutions[category];
  if (existing) {
    // Re-resolving (the organizer picked the wrong kid): reverse any
    // rollover credits the old winners already received, so the money
    // doesn't stay in the wrong account. Check every wallet first so a
    // credit that was already spent blocks the whole change, not half of it.
    for (const w of existing.winners) {
      if (w.disposition === 'rolled') {
        const wallet = walletFor(state, w.familyId);
        if (wallet.balanceCents < w.payoutCents) {
          throw new Error(
            `Cannot change ${CATEGORY_LABELS[category]}: ${w.buyer}'s $${(w.payoutCents / 100).toFixed(2)} ` +
              `rollover credit has already been spent (wallet balance $${(wallet.balanceCents / 100).toFixed(2)}). ` +
              `Add funds to the wallet first, or leave the winner as is.`
          );
        }
      }
    }
    for (const w of existing.winners) {
      if (w.disposition === 'rolled') {
        walletFor(state, w.familyId).balanceCents -= w.payoutCents;
      }
    }
  }
  const player = ROSTER_BY_NUMBER[playerNumber];
  if (!player) throw new Error(`Unknown player number: ${playerNumber}`);
  // First Goal: the goalie in net cannot score, and Harrison does not skate
  // out so he is out when he is the backup. Luke plays as a skater when
  // Harrison is in net, so he can be the First Goal scorer then.
  if (category === 'firstGoal' && (playerNumber === state.game.startingGoalie || (playerNumber === 29 && state.game.startingGoalie !== 29))) {
    throw new Error('That player is not in the First Goal draw');
  }
  // Harrison does not skate out, so when he is the backup he cannot be the
  // First Penalty or Playmaker either.
  if (category !== 'firstGoal' && playerNumber === 29 && state.game.startingGoalie !== 29) {
    throw new Error('Harrison is not playing this game');
  }

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
    drawMode: state.game.drawMode || 'mixed',
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
  // The draw mode carries too — the organizer changes it, not the reset.
  const nextCarryover = { ...entry.rollovers };
  state.game = {
    phase: 'setup',
    gameDate: null,
    opponent: null,
    startingGoalie: null,
    drawMode: state.game.drawMode || 'mixed',
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
  DRAW_MODES,
  DRAW_MODE_LABELS,
  TICKET_PRICE_PER_CATEGORY_CENTS,
  POT_SHARE_PER_CATEGORY_CENTS,
  SLUSH_SHARE_PER_CATEGORY_CENTS,
  createInitialState,
  familyIdForNumber,
  setGameInfo,
  setCarryover,
  setDrawMode,
  openGame,
  closeDraft,
  reopenDraft,
  rebuildDecks,
  deposit,
  buyTicket,
  resolveCategory,
  setPayout,
  resetGame,
  payAmanda,
  factoryReset,
  shuffle,
};
