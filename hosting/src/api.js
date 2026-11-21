// Wrappers around the Vercel serverless API (/api/*) and Firestore listeners.
// The organizer password is kept in module memory ONLY after login — it is
// never written to localStorage, sessionStorage, or Firestore.
//
// The API functions are plain HTTP endpoints (same origin as the site, so no
// CORS is involved). Each one answers `{ ok: true, ...result }` on success
// or `{ ok: false, error, code }` with a 4xx/5xx status on failure. This
// wrapper returns `{ data: <response> }` — the same shape the old Firebase
// callables returned — so the rest of the app is unchanged.
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from './firebase';

let organizerPassword = null;

export function setOrganizerPassword(pw) {
  organizerPassword = pw;
}
export function clearOrganizerPassword() {
  organizerPassword = null;
}
export function isOrganizerLoggedIn() {
  return organizerPassword !== null;
}
function withPassword(payload = {}) {
  return { ...payload, password: organizerPassword };
}

async function post(name, payload = {}) {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON response (e.g. a platform error page) — fall through to the
    // generic message below.
  }
  if (!res.ok) {
    throw new Error((json && (json.error || json.message)) || `Request failed (${res.status})`);
  }
  return { data: json };
}

export const api = {
  organizerLogin: (password) => post('organizer', { action: 'login', password }),
  initApp: () => post('initApp', withPassword()),
  deposit: (familyId, amountCents) =>
    post('deposit', withPassword({ familyId, amountCents })),
  buyTicket: (familyId, bettor, picks, mode, payLater, paidCash) =>
    paidCash
      ? post('buyTicket', withPassword({ familyId, bettor, picks, mode, payLater, paidCash }))
      : post('buyTicket', { familyId, bettor, picks, mode, payLater }),
  setGameInfo: (gameDate, opponent) =>
    post('game', withPassword({ action: 'setInfo', gameDate, opponent })),
  setCarryover: (category, amountCents) =>
    post('game', withPassword({ action: 'setCarryover', category, amountCents })),
  setDrawMode: (drawMode) =>
    post('game', withPassword({ action: 'setDrawMode', drawMode })),
  setGamesLeft: (gamesLeft) =>
    post('game', withPassword({ action: 'setGamesLeft', gamesLeft })),
  setScratched: (scratched) =>
    post('game', withPassword({ action: 'setScratched', scratched })),
  openGame: (gameDate, opponent, startingGoalie) =>
    post('game', withPassword({ action: 'open', gameDate, opponent, startingGoalie })),
  closeDraft: () => post('game', withPassword({ action: 'closeDraft' })),
  reopenDraft: () => post('game', withPassword({ action: 'reopenDraft' })),
  rebuildDecks: () => post('game', withPassword({ action: 'rebuildDecks' })),
  setStartingGoalie: (startingGoalie) =>
    post('game', withPassword({ action: 'setStartingGoalie', startingGoalie })),
  resolveCategory: (category, playerNumber) =>
    post('resolve', withPassword({ action: 'resolve', category, playerNumber })),
  rollCategory: (category) =>
    post('resolve', withPassword({ action: 'roll', category })),
  unrollCategory: (category) =>
    post('resolve', withPassword({ action: 'unroll', category })),
  setPayout: (category, ticketId, disposition) =>
    post('resolve', withPassword({ action: 'setPayout', category, ticketId, disposition })),
  resetGame: () => post('game', withPassword({ action: 'resetGame' })),
  voidGame: () => post('game', withPassword({ action: 'voidGame' })),
  payAmanda: () => post('game', withPassword({ action: 'payAmanda' })),
  exportBackup: () => post('backup', withPassword({ action: 'export' })),
  restoreBackup: (backup) => post('backup', withPassword({ action: 'restore', backup })),
  importLog: (entries) => post('backup', withPassword({ action: 'importLog', entries })),
  setSlush: (owedCents, sentCents, sentAt) =>
    post('backup', withPassword({ action: 'setSlush', owedCents, sentCents, sentAt })),
  fixLogGame: (fix) => post('backup', withPassword({ action: 'fixLogGame', ...fix })),
  setWallets: (balances) => post('backup', withPassword({ action: 'setWallets', balances })),
  setLogTickets: (games) => post('backup', withPassword({ action: 'setLogTickets', games })),
  factoryReset: () => post('game', withPassword({ action: 'factoryReset' })),
  changeOrganizerPassword: (newPassword) =>
    post('organizer', withPassword({ action: 'changePassword', newPassword })),
};

// Live listeners (read-only — Firestore rules deny client writes).
export function listenGame(cb) {
  return onSnapshot(doc(db, 'state/game'), (snap) => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

export function listenWallets(cb) {
  return onSnapshot(collection(db, 'wallets'), (snap) => {
    const out = {};
    snap.forEach((d) => {
      out[d.id] = { familyId: d.id, ...d.data() };
    });
    cb(out);
  });
}

export function listenGameLog(cb) {
  const q = query(collection(db, 'gamelog'), orderBy('endedAt', 'desc'));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}
