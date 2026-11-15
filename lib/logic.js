// Pure money / game logic for the Foxes Slush Fund Draft app.
// This module has NO Firebase dependencies so it can be unit-tested with plain Node.
// All amounts are integer cents.
//
// Money rules (must match the locked Muse version):
// - A play costs $2 per category ($6 for all three). Of each $2, $1 goes to that
//   category's pot and $1 goes to the slush.
// - The slush is a SEASON total owed to Amanda Beckett; it is never touched by resets.
// - Resolving a category: winners are the tickets that picked the resolved player.
//   The pot splits equally among winning tickets (remainder cents go to the first
//   winners, in play order).
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
// 'mixed'    = each parent picks virtual or real chips per play (default)
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
      scratched: [], // jersey numbers out for this game (sick / hurt / not dressing)
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

// Players actually playing this game, after the goalie rules and the
// organizer's scratches. The starting goalie plays (in net). Harrison
// (#29) does not skate out, so he is out when he is the backup. Luke
// (#88) plays as a skater when Harrison is in net. A scratched player
// (sick, hurt, not dressing) is out of every category.
function inGamePlayers(startingGoalie, scratched = []) {
  const out = new Set(scratched || []);
  return ROSTER.filter((p) => {
    if (out.has(p.number)) return false; // scratched — not playing this game
    if (p.number === startingGoalie) return true; // starting goalie plays (in net)
    if (p.number === 29) return false; // Harrison is out when he is the backup
    return true; // everyone else, including Luke as a skater when backup
  });
}

// Validate and normalize a list of scratched jersey numbers.
function normalizeScratched(numbers) {
  if (numbers === undefined || numbers === null) return [];
  if (!Array.isArray(numbers)) throw new Error('Scratched players must be a list of jersey numbers');
  const out = [];
  for (const n of numbers) {
    const num = Number(n);
    if (!ROSTER_BY_NUMBER[num]) throw new Error(`Unknown player number: ${n}`);
    if (!out.includes(num)) out.push(num);
  }
  return out;
}

// Build the three decks for a game, from who is actually playing.
// The starting goalie (in net) cannot score, so he is out of First Goal
// only — he is still in First Penalty and Playmaker. Harrison (#29) does
// not skate out, so when he is the backup he is out of every category.
// Luke (#88) plays as a skater when Harrison is in net, so he is in all
// three categories then. Everyone else is a skater, in every category.
// Scratched players are out of every deck.
function buildDecks(startingGoalie, rng, scratched = []) {
  const inGame = inGamePlayers(startingGoalie, scratched);
  const firstGoalPool = inGame.filter((p) => p.number !== startingGoalie);
  return {
    firstGoal: shuffle(firstGoalPool.map((p) => p.number), rng),
    firstPenalty: shuffle(inGame.map((p) => p.number), rng),
    playmaker: shuffle(inGame.map((p) => p.number), rng),
  };
}

// Step 4 of Start a New Game: lock the roster, shuffle the three decks
// server-side, open the draft. Pots start at the carryover amounts.
function openGame(state, { gameDate, opponent, startingGoalie, scratched, rng } = {}) {
  if (state.game.phase !== 'setup') {
    throw new Error('A game is already open');
  }
  if (startingGoalie !== undefined && startingGoalie !== null && !GOALIES.includes(startingGoalie)) {
    throw new Error('Starting goalie must be #29 or #88');
  }
  if (gameDate !== undefined) state.game.gameDate = gameDate;
  if (opponent !== undefined) state.game.opponent = opponent;
  if (startingGoalie !== undefined) state.game.startingGoalie = startingGoalie;
  if (scratched !== undefined) state.game.scratched = normalizeScratched(scratched);
  if (!Array.isArray(state.game.scratched)) state.game.scratched = [];

  state.game.decks = buildDecks(state.game.startingGoalie, rng, state.game.scratched);
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

// Rebuild all three decks from the current starting goalie and scratches,
// keeping any cards already drawn by sold tickets out of the deck.
function refreshDecks(state) {
  const fresh = buildDecks(state.game.startingGoalie, Math.random, state.game.scratched || []);
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

// One-time fix for a game opened before a deck rule changed: rebuild all
// three decks from the current starting goalie, keeping any cards already
// drawn by sold tickets out of the deck.
function rebuildDecks(state) {
  if (state.game.phase !== 'open' && state.game.phase !== 'closed') {
    throw new Error('No game is open to fix');
  }
  return refreshDecks(state);
}

// The organizer scratches players who are not playing this game (sick,
// hurt, not dressing) — as many at once as needed. A scratched player is
// out of every category: he cannot be picked and cannot be resolved as a
// winner. Works in setup (the list is stored and the decks are built
// without them when the game opens) and while the draft is open or
// closed (the decks are rebuilt, keeping cards already drawn by sold
// plays — a play already sold on a player who is later scratched stays
// as it is). Returns the saved list plus any scratched players who
// already have plays on them, so the organizer can be told.
function setScratched(state, numbers) {
  const scratched = normalizeScratched(numbers);
  state.game.scratched = scratched;
  if (state.game.phase === 'open' || state.game.phase === 'closed') {
    refreshDecks(state);
  }
  const picked = new Set();
  for (const t of state.tickets || []) {
    for (const c of CATEGORIES) {
      const n = t.picks?.[c]?.number;
      if (n != null) picked.add(n);
    }
  }
  const alreadyPicked = scratched.filter((n) => picked.has(n));
  return { scratched, alreadyPicked };
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
// payLater: the parent chose "Play now pay later" — the play goes through
// even if the wallet is short, and the wallet balance goes negative until
// the organizer records a deposit.
function buyTicket(state, { familyId, buyer, bettor, picks, mode, payLater }) {
  if (state.game.phase !== 'open') {
    throw new Error('No game is open — the draft is closed');
  }
  const wallet = walletFor(state, familyId);
  // Who is placing this bet? One play per person per game — several people
  // in the same family may each buy their own ticket from the shared wallet.
  const bettorName = String(bettor || buyer || wallet.family || '').trim();
  if (!bettorName) throw new Error('Pick who is betting first');
  if (state.tickets.some((t) => t.familyId === String(familyId) && (t.bettor || t.buyer) === bettorName)) {
    throw new Error(`${bettorName} already has a play for this game`);
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
      if ((state.game.scratched || []).includes(pick)) {
        throw new Error('That player is scratched — he is not playing this game. Draw another chip');
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
      // Scratched players are never drawn.
      const inGame = inGamePlayers(state.game.startingGoalie, state.game.scratched || []);
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
  if ((state.game.scratched || []).includes(playerNumber)) {
    throw new Error('That player is scratched — he is not playing this game');
  }
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
    // Split the pot equally; remainder cents go to the first winners, in play order.
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
    scratched: [...(state.game.scratched || [])],
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
    scratched: [],
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

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

// Everything that defines the app's data, in one JSON-safe object: the
// wallets, the current game (including the decks), the current game's
// plays, the season slush and its payments to Amanda, and the whole Game
// Log. The organizer downloads it from the Organizer Page; if the app is
// ever wiped (factory reset, accident), restoring the file brings it all
// back. The organizer password is NOT part of the backup — it lives
// outside this state and is never exported.
function buildBackup(state, logEntries) {
  return {
    app: 'foxes-slush-fund',
    version: 1,
    exportedAt: new Date().toISOString(),
    wallets: JSON.parse(JSON.stringify(state.wallets)),
    game: JSON.parse(JSON.stringify(state.game)),
    tickets: JSON.parse(JSON.stringify(state.tickets || [])),
    slushCents: state.slushCents || 0,
    slushPayments: JSON.parse(JSON.stringify(state.slushPayments || [])),
    log: JSON.parse(JSON.stringify(logEntries || state.log || [])),
  };
}

function backupPots(value, label) {
  const out = emptyPots();
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Backup ${label} is malformed`);
  for (const c of CATEGORIES) {
    const v = value[c];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0) throw new Error(`Backup ${label} is not a valid amount`);
    out[c] = v;
  }
  return out;
}

// Replace the whole state with a backup made by buildBackup. Every piece
// is validated into fresh objects first and the state is swapped only
// once everything checks out, so a bad file changes nothing. Returns a
// summary plus the Game Log entries (the server writes those to their
// own collection when restoring).
function applyBackup(state, backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('That file is not a backup — it could not be read.');
  }
  if (backup.app !== 'foxes-slush-fund') {
    throw new Error('That file is not a Foxes Slush Fund backup.');
  }
  if (!backup.wallets || typeof backup.wallets !== 'object' || Array.isArray(backup.wallets)) {
    throw new Error('Backup is missing the wallets.');
  }
  if (!Array.isArray(backup.log)) {
    throw new Error('Backup is missing the Game Log.');
  }
  if (!backup.game || typeof backup.game !== 'object' || Array.isArray(backup.game)) {
    throw new Error('Backup is missing the game state.');
  }

  // Wallets: exactly the backed-up families, with validated balances
  // (a balance may be negative — play now, pay later).
  const wallets = {};
  for (const [id, w] of Object.entries(backup.wallets)) {
    if (!w || typeof w !== 'object') throw new Error(`Backup wallet ${id} is malformed`);
    if (!Number.isInteger(w.balanceCents)) throw new Error(`Backup wallet ${id} has no valid balance`);
    wallets[id] = {
      familyId: id,
      family: typeof w.family === 'string' ? w.family : '',
      familyLabel: typeof w.familyLabel === 'string' ? w.familyLabel : (typeof w.family === 'string' ? w.family : ''),
      codes: Array.isArray(w.codes) ? w.codes.filter((n) => Number.isInteger(n)) : [],
      balanceCents: w.balanceCents,
    };
  }
  if (Object.keys(wallets).length === 0) throw new Error('Backup has no wallets.');

  // The current game.
  const g = backup.game;
  const phase = ['setup', 'open', 'closed'].includes(g.phase) ? g.phase : 'setup';
  const game = {
    phase,
    gameDate: typeof g.gameDate === 'string' ? g.gameDate : null,
    opponent: typeof g.opponent === 'string' ? g.opponent : null,
    startingGoalie: GOALIES.includes(g.startingGoalie) ? g.startingGoalie : null,
    drawMode: DRAW_MODES.includes(g.drawMode) ? g.drawMode : 'mixed',
    scratched: normalizeScratched(g.scratched || []),
    pots: backupPots(g.pots, 'pots'),
    carryover: backupPots(g.carryover, 'carryover'),
    startingPots: backupPots(g.startingPots, 'startingPots'),
    resolutions: emptyResolutions(),
    decks: emptyDecks(),
    slushGameCents: Number.isInteger(g.slushGameCents) && g.slushGameCents >= 0 ? g.slushGameCents : 0,
  };
  if (g.resolutions && typeof g.resolutions === 'object' && !Array.isArray(g.resolutions)) {
    for (const c of CATEGORIES) {
      const r = g.resolutions[c];
      if (r && typeof r === 'object' && Array.isArray(r.winners)) game.resolutions[c] = r;
    }
  }

  // Plays for the current game.
  if (backup.tickets !== undefined && !Array.isArray(backup.tickets)) {
    throw new Error('Backup plays are malformed.');
  }
  const tickets = JSON.parse(JSON.stringify(backup.tickets || []));

  // Decks: use the backed-up decks when they are valid lists of player
  // numbers. If they are missing or malformed, they are rebuilt below
  // from the goalie and scratches, keeping drawn cards out — the shuffle
  // order is not part of the data (nobody can see it), so a rebuilt deck
  // plays exactly the same.
  const decksValid = g.decks && typeof g.decks === 'object' &&
    CATEGORIES.every((c) => Array.isArray(g.decks[c]) && g.decks[c].every((n) => ROSTER_BY_NUMBER[n]));
  if (decksValid) {
    game.decks = {
      firstGoal: [...g.decks.firstGoal],
      firstPenalty: [...g.decks.firstPenalty],
      playmaker: [...g.decks.playmaker],
    };
  }

  // Season slush and payments to Amanda.
  if (!Number.isInteger(backup.slushCents) || backup.slushCents < 0) {
    throw new Error('Backup slush total is not valid.');
  }
  const slushPayments = Array.isArray(backup.slushPayments)
    ? backup.slushPayments.filter((p) => p && Number.isInteger(p.amountCents))
    : [];

  // Game Log entries are historical records that are only displayed, so
  // they pass through once each one is confirmed to be an object.
  const logEntries = backup.log.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Backup Game Log entry ${i + 1} is malformed.`);
    }
    return JSON.parse(JSON.stringify(entry));
  });

  // Everything validated — swap the state.
  state.wallets = wallets;
  state.game = game;
  state.tickets = tickets;
  state.slushCents = backup.slushCents;
  state.slushPayments = slushPayments;
  state.log = logEntries;
  if (!decksValid && (phase === 'open' || phase === 'closed')) {
    refreshDecks(state);
  }
  return {
    summary: {
      gamesRestored: logEntries.length,
      walletsRestored: Object.keys(wallets).length,
      slushCents: state.slushCents,
    },
    logEntries,
  };
}

// Validate a list of Game Log entries for import (e.g. the season's
// earlier games, rebuilt from the old pool dashboard). Each entry is
// checked and rebuilt with defaults for anything optional, so what lands
// in the log is always in the shape the app displays. Importing only
// ever ADDS log entries — wallets, slush and the current game are never
// part of an import.
function validateImportEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Import file has no games in it.');
  }
  return entries.map((e, i) => {
    const bad = (what) => new Error(`Import game ${i + 1}: ${what}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('not a game record');
    if (typeof e.gameDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.gameDate)) throw bad('bad date');
    if (typeof e.opponent !== 'string' || !e.opponent.trim()) throw bad('missing opponent');
    let pots;
    let startingPots;
    let rollovers;
    try {
      pots = backupPots(e.pots, 'pots');
      startingPots = e.startingPots === undefined ? { ...pots } : backupPots(e.startingPots, 'startingPots');
      rollovers = e.rollovers === undefined ? emptyPots() : backupPots(e.rollovers, 'rollovers');
    } catch (err) {
      throw bad(err.message);
    }
    const resolutions = emptyResolutions();
    if (e.resolutions !== undefined) {
      if (!e.resolutions || typeof e.resolutions !== 'object' || Array.isArray(e.resolutions)) {
        throw bad('resolutions are malformed');
      }
      for (const c of CATEGORIES) {
        const r = e.resolutions[c];
        if (r === undefined || r === null) continue;
        if (typeof r !== 'object' || !ROSTER_BY_NUMBER[r.playerNumber] || !Array.isArray(r.winners)) {
          throw bad(`${c} result is malformed`);
        }
        const winners = r.winners.map((w) => {
          if (!w || typeof w.buyer !== 'string' || !w.buyer || !Number.isInteger(w.payoutCents) || w.payoutCents < 0) {
            throw bad(`${c} winner is malformed`);
          }
          return {
            ticketId: typeof w.ticketId === 'string' ? w.ticketId : null,
            buyer: w.buyer,
            family: typeof w.family === 'string' ? w.family : '',
            familyId: w.familyId === undefined ? '' : String(w.familyId),
            payoutCents: w.payoutCents,
            disposition: ['paid', 'rolled', 'unmarked'].includes(w.disposition) ? w.disposition : 'paid',
          };
        });
        resolutions[c] = {
          playerNumber: r.playerNumber,
          playerName: ROSTER_BY_NUMBER[r.playerNumber].name,
          potCents: Number.isInteger(r.potCents) && r.potCents >= 0 ? r.potCents : pots[c],
          winners,
        };
      }
    }
    if (e.tickets !== undefined && !Array.isArray(e.tickets)) throw bad('plays are malformed');
    const nonNegInt = (v, fallback) => (Number.isInteger(v) && v >= 0 ? v : fallback);
    return {
      gameDate: e.gameDate,
      opponent: e.opponent.trim(),
      startingGoalie: GOALIES.includes(e.startingGoalie) ? e.startingGoalie : null,
      drawMode: DRAW_MODES.includes(e.drawMode) ? e.drawMode : 'physical',
      scratched: normalizeScratched(e.scratched || []),
      pots,
      startingPots,
      tickets: JSON.parse(JSON.stringify(e.tickets || [])),
      resolutions,
      rollovers,
      slushGameCents: nonNegInt(e.slushGameCents, 0),
      slushSeasonCents: nonNegInt(e.slushSeasonCents, 0),
      endedAt: typeof e.endedAt === 'string' ? e.endedAt : `${e.gameDate}T23:59:00.000Z`,
      imported: e.imported === true,
    };
  });
}

// ---------------------------------------------------------------------------
// Corrections ("fix the books"). The organizer is the source of truth for
// money that moved outside the app — cash handed to Amanda, a winner who
// rolled instead of taking cash. These helpers let the recorded numbers be
// corrected to match, with the same validation as everything else.

// Set the season slush position directly: how much has already been sent to
// Amanda in total, and how much is still owed. The sent total is recorded
// as a single payment line dated `sentAt` (the organizer's correction is
// the record; per-batch history lives in the old ledger).
function correctSlush(state, { owedCents, sentCents, sentAt } = {}) {
  const MAX = 100000000; // $1,000,000 — a sanity cap, not a real limit.
  if (!Number.isInteger(owedCents) || owedCents < 0 || owedCents > MAX) {
    throw new Error('Slush still owed must be a whole number of cents, $0 or more.');
  }
  if (!Number.isInteger(sentCents) || sentCents < 0 || sentCents > MAX) {
    throw new Error('Slush already sent must be a whole number of cents, $0 or more.');
  }
  state.slushCents = owedCents;
  state.slushPayments = sentCents > 0
    ? [{ amountCents: sentCents, paidAt: typeof sentAt === 'string' && sentAt ? sentAt : new Date().toISOString() }]
    : [];
  return { slushCents: state.slushCents, sentCents };
}

// Wallet adjustment (cents) when a logged game's winner is re-marked from
// one disposition to another: paid -> rolled credits the family wallet with
// the payout; rolled -> paid takes it back out. Returns 0 when nothing
// moves (no named winner, no payout, or the disposition is unchanged).
function logFixDelta(winner, newDisposition) {
  if (newDisposition !== 'paid' && newDisposition !== 'rolled') {
    throw new Error("Disposition must be 'paid' or 'rolled'.");
  }
  if (!winner || !winner.buyer || !winner.familyId) return 0;
  const payout = Number.isInteger(winner.payoutCents) ? winner.payoutCents : 0;
  if (payout <= 0 || winner.disposition === newDisposition) return 0;
  if (winner.disposition === 'paid' && newDisposition === 'rolled') return payout;
  if (winner.disposition === 'rolled' && newDisposition === 'paid') return -payout;
  return 0;
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
  setScratched,
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
  buildBackup,
  applyBackup,
  validateImportEntries,
  correctSlush,
  logFixDelta,
  shuffle,
};
