// POST /api/backup — { password, action, ... }.
// Password-gated organizer endpoint for season backups.
// action: 'export' | 'restore' | 'importLog' | 'setSlush' | 'fixLogGame'.
//   export:    {} -> { backup }   (the whole app state as one JSON object:
//              wallets, current game incl. decks and plays, season slush,
//              payments to Amanda, and the full Game Log)
//   restore:   { backup } -> { gamesRestored, walletsRestored, slushCents }
//              Replaces EVERYTHING in the app with the backup — the
//              organizer password is not part of a backup and never changes.
//   importLog: { entries } -> { imported, skipped }
//              Adds Game Log entries (e.g. older games rebuilt from the old
//              pool dashboard). Add-only: a game whose date + opponent is
//              already in the log is skipped, and wallets, slush and the
//              current game are never touched.
//   setSlush:  { owedCents, sentCents, sentAt? } -> { slushCents, sentCents }
//              Corrects the season slush position to match money that moved
//              outside the app (see logic.correctSlush).
//   fixLogGame: { gameDate, opponent, category?, disposition?,
//                 slushGameCents?, slushSeasonCents? }
//              -> { walletDeltaCents }
//              Corrects one logged game: re-mark a winner paid <-> rolled
//              (moving the payout in or out of that family's wallet) and/or
//              set the slush recorded for that game.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const action = body && body.action;
  if (action === 'export') {
    const firestore = db.db();
    const backup = await firestore.runTransaction(async (tx) => {
      const state = await db.loadState(firestore, tx);
      const logSnap = await tx.get(
        firestore.collection('gamelog').orderBy('endedAt', 'desc')
      );
      const entries = logSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
      return logic.buildBackup(state, entries);
    });
    return { backup };
  }
  if (action === 'restore') {
    const summary = await db.withState((state) => {
      const r = logic.applyBackup(state, body.backup);
      return { result: r.summary, replaceLog: r.logEntries };
    });
    return { ...summary };
  }
  if (action === 'importLog') {
    const entries = logic.validateImportEntries(body.entries);
    const firestore = db.db();
    return firestore.runTransaction(async (tx) => {
      // Read first (Firestore: all reads before all writes), then insert
      // only the games that are not already logged.
      const snap = await tx.get(firestore.collection('gamelog'));
      const existing = new Set(
        snap.docs.map((d) => `${d.data().gameDate}|${d.data().opponent}`)
      );
      let imported = 0;
      let skipped = 0;
      for (const entry of entries) {
        const key = `${entry.gameDate}|${entry.opponent}`;
        if (existing.has(key)) {
          skipped++;
          continue;
        }
        const ref = firestore.collection('gamelog').doc();
        tx.set(ref, { ...entry, id: ref.id });
        existing.add(key);
        imported++;
      }
      return { imported, skipped };
    });
  }
  if (action === 'setSlush') {
    return db.withState((state) => ({
      result: logic.correctSlush(state, {
        owedCents: body.owedCents,
        sentCents: body.sentCents,
        sentAt: body.sentAt,
      }),
    }));
  }
  if (action === 'setWallets') {
    return db.withState((state) => ({
      result: logic.setWalletBalances(state, body.balances),
    }));
  }
  if (action === 'fixLogGame') {
    const { gameDate, opponent, category, disposition } = body || {};
    if (typeof gameDate !== 'string' || !gameDate || typeof opponent !== 'string' || !opponent) {
      throw new Error('gameDate and opponent are required.');
    }
    const hasDisposition = category !== undefined || disposition !== undefined;
    if (hasDisposition) {
      if (!logic.CATEGORIES.includes(category)) {
        throw new Error(`Unknown category: ${category}`);
      }
      if (disposition !== 'paid' && disposition !== 'rolled') {
        throw new Error("Disposition must be 'paid' or 'rolled'.");
      }
    }
    const hasSlush = body.slushGameCents !== undefined || body.slushSeasonCents !== undefined;
    for (const key of ['slushGameCents', 'slushSeasonCents']) {
      if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < 0)) {
        throw new Error(`${key} must be a whole number of cents, $0 or more.`);
      }
    }
    if (!hasDisposition && !hasSlush) {
      throw new Error('Nothing to fix: give a winner disposition and/or slush amounts.');
    }
    const firestore = db.db();
    return firestore.runTransaction(async (tx) => {
      // All reads before all writes (Firestore transaction rule).
      const snap = await tx.get(firestore.collection('gamelog'));
      const doc = snap.docs.find(
        (d) => d.data().gameDate === gameDate && d.data().opponent === opponent
      );
      if (!doc) throw new Error(`No logged game found for ${gameDate} vs ${opponent}.`);
      const entry = { ...doc.data() };
      const walletWrites = [];
      let walletDeltaCents = 0;
      if (hasDisposition) {
        const res = entry.resolutions && entry.resolutions[category];
        const winners = (res && res.winners) || [];
        const payable = winners.filter(
          (w) => w && w.buyer && w.familyId && w.payoutCents > 0
        );
        if (!payable.length) {
          throw new Error('That category has no winner with a payout to fix.');
        }
        const deltas = {};
        for (const w of payable) {
          const d = logic.logFixDelta(w, disposition);
          if (d !== 0) deltas[w.familyId] = (deltas[w.familyId] || 0) + d;
        }
        for (const [familyId, delta] of Object.entries(deltas)) {
          const ref = firestore.doc(`wallets/${familyId}`);
          const wSnap = await tx.get(ref);
          walletWrites.push({
            ref,
            balanceCents: (wSnap.exists ? wSnap.data().balanceCents || 0 : 0) + delta,
          });
          walletDeltaCents += delta;
        }
        entry.resolutions = {
          ...entry.resolutions,
          [category]: {
            ...res,
            winners: winners.map((w) => ({ ...w, disposition })),
          },
        };
      }
      if (body.slushGameCents !== undefined) {
        entry.slushGameCents = body.slushGameCents;
        // A game with a recorded slush is no longer "not recorded".
        entry.imported = false;
      }
      if (body.slushSeasonCents !== undefined) entry.slushSeasonCents = body.slushSeasonCents;
      tx.set(doc.ref, entry);
      for (const w of walletWrites) tx.update(w.ref, { balanceCents: w.balanceCents });
      return { walletDeltaCents };
    });
  }
  throw new Error(`Unknown backup action: ${action}`);
});
