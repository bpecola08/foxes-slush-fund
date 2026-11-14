// Shared server-side Firestore access for the Vercel API functions.
//
// The Vercel functions (api/*.js) are plain HTTP handlers. They call into
// here for everything that touches Firestore, and into lib/logic.js for the
// money/game rules. The rules are identical to the old Cloud Functions
// version: all money logic runs ONLY here, server-side, inside Firestore
// transactions. Clients can READ the public game state, wallets, tickets and
// game log, but firestore.rules denies every direct client WRITE.
//
// Credentials: the server authenticates to Firestore with a service account.
// On Vercel it comes from the FIREBASE_SERVICE_ACCOUNT environment variable
// (the full service-account JSON, set in the Vercel dashboard — never
// committed). Locally, GOOGLE_APPLICATION_CREDENTIALS (path to the
// service-account JSON file) or ambient Application Default Credentials work.
//
// The organizer password is checked server-side on every organizer call
// against the scrypt hash stored in the Firestore document
// `private/organizer` (see scripts/setup.js). The plaintext password never
// appears in this repo, in client code, or in Firestore.

const admin = require('firebase-admin');
const logic = require('../../lib/logic');

const GAME_DOC = 'state/game';
const DECKS_DOC = 'private/decks';
const ORGANIZER_DOC = 'private/organizer';

// Error carrying an HTTP status, so the HTTP wrapper (api/_lib/http.js) can
// answer with the right code. Logic/validation problems are 400s, a bad or
// missing organizer password is a 401.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let firestoreInstance = null;

function getFirestore() {
  if (firestoreInstance) return firestoreInstance;
  if (!admin.apps.length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (sa) {
      // Vercel: full service-account JSON in one env var.
      const creds = JSON.parse(sa);
      admin.initializeApp({
        credential: admin.credential.cert(creds),
        projectId: creds.project_id,
      });
    } else {
      // Local runs: GOOGLE_APPLICATION_CREDENTIALS or ambient ADC.
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }
  }
  firestoreInstance = admin.firestore();
  return firestoreInstance;
}

// Firestore instance (lazily initialized so unit tests can load this module
// without credentials).
function db() {
  return getFirestore();
}

function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

async function getPasswordHash(firestore) {
  const snap = await firestore.doc(ORGANIZER_DOC).get();
  if (!snap.exists) {
    throw new ApiError(
      412,
      'failed_precondition',
      'Organizer password has not been set up yet. Run scripts/setup.js first (see README).'
    );
  }
  return snap.data().passwordHash;
}

async function requireOrganizer(body) {
  const password = body && body.password;
  if (typeof password !== 'string' || password.length === 0) {
    throw new ApiError(401, 'unauthenticated', 'Organizer password required');
  }
  const { verifyPassword } = require('../../lib/auth');
  const hash = await getPasswordHash(db());
  if (!verifyPassword(password, hash)) {
    throw new ApiError(401, 'unauthenticated', 'Wrong organizer password');
  }
}

// Load the full plain-logic state from Firestore (inside a transaction).
async function loadState(firestore, tx) {
  const gameSnap = await tx.get(firestore.doc(GAME_DOC));
  const decksSnap = await tx.get(firestore.doc(DECKS_DOC));
  const walletsSnap = await tx.get(firestore.collection('wallets'));

  let state;
  if (!gameSnap.exists) {
    state = logic.createInitialState();
  } else {
    const g = gameSnap.data();
    state = {
      wallets: {},
      game: {
        phase: g.phase,
        gameDate: g.gameDate ?? null,
        opponent: g.opponent ?? null,
        startingGoalie: g.startingGoalie ?? null,
        drawMode: g.drawMode || 'mixed',
        scratched: g.scratched || [],
        pots: g.pots,
        carryover: g.carryover,
        startingPots: g.startingPots,
        resolutions: g.resolutions,
        decks: decksSnap.exists
          ? decksSnap.data().decks
          : { firstGoal: [], firstPenalty: [], playmaker: [] },
        slushGameCents: g.slushGameCents || 0,
      },
      tickets: g.tickets || [],
      slushCents: g.slushCents || 0,
      slushPayments: g.slushPayments || [],
      log: [],
    };
  }
  for (const doc of walletsSnap.docs) {
    const w = doc.data();
    state.wallets[doc.id] = {
      familyId: doc.id,
      family: w.family,
      familyLabel: w.familyLabel,
      codes: w.codes,
      balanceCents: w.balanceCents,
    };
  }
  // Fill in any wallet missing from Firestore (first run / roster change).
  const fresh = logic.createInitialState();
  for (const [id, w] of Object.entries(fresh.wallets)) {
    if (!state.wallets[id]) state.wallets[id] = w;
  }
  return state;
}

// Persist the plain-logic state back to Firestore (inside a transaction).
function saveState(firestore, tx, state, gameId) {
  const { decks, ...gameWithoutDecks } = state.game;
  tx.set(firestore.doc(GAME_DOC), {
    gameId,
    ...gameWithoutDecks,
    // Remaining cards per category (counts ONLY — the shuffled order stays
    // server-side in private/decks so nobody can cherry-pick a player).
    deckCounts: {
      firstGoal: decks.firstGoal.length,
      firstPenalty: decks.firstPenalty.length,
      playmaker: decks.playmaker.length,
    },
    tickets: state.tickets,
    slushCents: state.slushCents,
    slushPayments: state.slushPayments || [],
  });
  tx.set(firestore.doc(DECKS_DOC), { gameId, decks: state.game.decks });
  for (const [id, w] of Object.entries(state.wallets)) {
    tx.set(firestore.doc(`wallets/${id}`), {
      family: w.family,
      familyLabel: w.familyLabel,
      codes: w.codes,
      balanceCents: w.balanceCents,
    });
  }
}

function currentGameId(gameSnapData) {
  return (gameSnapData && gameSnapData.gameId) || 'game-1';
}

// Runs a logic mutation inside a transaction. `mutator` receives the plain
// state and returns an optional extra value to send back to the caller.
// The mutator may also return { logEntry } (written to the game log) and
// { nextGameId } / { deleteLog } (see resetGame / factoryReset).
async function withState(mutator) {
  const firestore = db();
  let result;
  await firestore.runTransaction(async (tx) => {
    const gameSnap = await tx.get(firestore.doc(GAME_DOC));
    const gameId = currentGameId(gameSnap.exists ? gameSnap.data() : null);
    const state = await loadState(firestore, tx);
    const out = mutator(state, gameId);
    result = out && out.result !== undefined ? out.result : out;
    // Firestore requires every read to happen before every write, so the
    // game-log read for deleteLog must come before the saveState writes.
    const logSnap = out && out.deleteLog
      ? await tx.get(firestore.collection('gamelog'))
      : null;
    saveState(firestore, tx, state, out && out.nextGameId ? out.nextGameId : gameId);
    if (out && out.logEntry) {
      const logRef = firestore.collection('gamelog').doc();
      tx.set(logRef, { ...out.logEntry, id: logRef.id });
    }
    if (logSnap) {
      for (const doc of logSnap.docs) tx.delete(doc.ref);
    }
  });
  return result;
}

// Convert any thrown error into an ApiError. ApiErrors pass through;
// everything else (logic validation, bad input) becomes a 400.
function toApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError(400, 'failed_precondition', err && err.message ? err.message : 'Operation failed');
}

module.exports = {
  ApiError,
  db,
  serverTimestamp,
  getPasswordHash,
  requireOrganizer,
  loadState,
  saveState,
  withState,
  toApiError,
  GAME_DOC,
  DECKS_DOC,
  ORGANIZER_DOC,
};
