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
//                 playerNumber?, slushGameCents?, slushSeasonCents? }
//              -> { walletDeltaCents }
//              Corrects one logged game: re-mark a winner paid <-> rolled
//              (moving the payout in or out of that family's wallet), set
//              the winner of a category that was logged as a no-winner
//              rollover (playerNumber — the rolled pot comes back out of
//              the next game's carryover so it is not paid twice), and/or
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
  if (action === 'setLogTickets') {
    // { games: [{ gameDate, opponent, tickets, winnerTickets? }] } -> { updated, skipped }
    // Fills in the plays (who picked what) for games already in the log —
    // e.g. older games whose winners were imported before their pick lists
    // were pulled from the old dashboard. Replaces only each game's plays
    // and links each winner to their play; winners, pots, wallets and slush
    // are never touched, so re-running it is safe.
    const games = Array.isArray(body.games) ? body.games : [];
    if (!games.length || games.length > 20) throw new Error('No games supplied.');
    const FAMILY_IDS = new Set(['9', '16', '17', '19', '20', '22', '23', '24', '29', '55', '58', '88', '94', '96', '98']);
    for (const g of games) {
      if (!g || typeof g.gameDate !== 'string' || !g.gameDate || typeof g.opponent !== 'string' || !g.opponent || !Array.isArray(g.tickets)) {
        throw new Error('Each game needs a date, an opponent and a plays list.');
      }
      for (const t of g.tickets) {
        if (!t || typeof t.id !== 'string' || typeof t.buyer !== 'string' || !FAMILY_IDS.has(t.familyId) || !t.picks || typeof t.picks !== 'object') {
          throw new Error(`A play in the ${g.opponent} game is malformed.`);
        }
        for (const c of logic.CATEGORIES) {
          const v = t.picks[c];
          if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 1 || v > 99)) {
            throw new Error(`A pick in the ${g.opponent} game is malformed.`);
          }
        }
        if (![200, 400, 600].includes(t.paidCents)) {
          throw new Error(`A play price in the ${g.opponent} game is malformed.`);
        }
      }
    }
    const firestore = db.db();
    const snap = await firestore.collection('gamelog').get();
    const byKey = new Map();
    snap.forEach((d) => { const e = d.data(); byKey.set(`${e.gameDate}|${e.opponent}`, { ref: d.ref, entry: e }); });
    const batch = firestore.batch();
    let updated = 0;
    const skipped = [];
    for (const g of games) {
      const hit = byKey.get(`${g.gameDate}|${g.opponent}`);
      if (!hit) { skipped.push(`${g.gameDate} ${g.opponent}`); continue; }
      const update = { tickets: g.tickets };
      if (g.winnerTickets && typeof g.winnerTickets === 'object') {
        const resolutions = JSON.parse(JSON.stringify(hit.entry.resolutions || {}));
        let touched = false;
        for (const c of logic.CATEGORIES) {
          const tid = g.winnerTickets[c];
          if (tid && resolutions[c] && Array.isArray(resolutions[c].winners) && resolutions[c].winners[0]) {
            resolutions[c].winners[0] = { ...resolutions[c].winners[0], ticketId: tid };
            touched = true;
          }
        }
        if (touched) update.resolutions = resolutions;
      }
      batch.update(hit.ref, update);
      updated += 1;
    }
    if (updated) await batch.commit();
    return { updated, skipped };
  }
  if (action === 'fixLogGame') {
    const { gameDate, opponent, category, disposition, playerNumber } = body || {};
    if (typeof gameDate !== 'string' || !gameDate || typeof opponent !== 'string' || !opponent) {
      throw new Error('gameDate and opponent are required.');
    }
    const hasSetWinner = playerNumber !== undefined;
    const hasDisposition = !hasSetWinner && (category !== undefined || disposition !== undefined);
    if (hasSetWinner) {
      if (!logic.CATEGORIES.includes(category)) {
        throw new Error(`Unknown category: ${category}`);
      }
      if (disposition !== 'paid' && disposition !== 'rolled') {
        throw new Error("Disposition must be 'paid' or 'rolled'.");
      }
      if (!Number.isInteger(playerNumber)) {
        throw new Error('playerNumber must be a whole number.');
      }
    }
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
    if (!hasDisposition && !hasSetWinner && !hasSlush) {
      throw new Error('Nothing to fix: give a winner disposition, a winner to set, and/or slush amounts.');
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
      let gameUpdate = null;
      let paidOutCents = 0;
      if (hasSetWinner) {
        const fix = logic.computeLogWinner(entry, category, playerNumber);
        const res = {
          ...fix.resolution,
          winners: fix.resolution.winners.map((w) => ({ ...w, disposition })),
        };
        entry.resolutions = { ...entry.resolutions, [category]: res };
        paidOutCents = fix.paidOutCents;
        if (entry.rollovers && Number.isInteger(entry.rollovers[category])) {
          entry.rollovers = {
            ...entry.rollovers,
            [category]: Math.max(0, entry.rollovers[category] - paidOutCents),
          };
        }
        if (paidOutCents > 0) {
          // The pot that rolled is still sitting in the next game's
          // carryover — take it back out so it is not paid twice. Only
          // valid between games (phase 'setup'), before the carryover
          // has been baked into a live game's pots.
          const gameSnap = await tx.get(firestore.doc('state/game'));
          if (gameSnap.exists) {
            const g = gameSnap.data();
            if (g.phase && g.phase !== 'setup') {
              throw new Error('A game is already open — set this winner before opening the next game, so the rolled pot is not paid twice.');
            }
            const carryover = { ...(g.carryover || {}) };
            const pots = { ...(g.pots || {}) };
            carryover[category] = Math.max(0, (carryover[category] || 0) - paidOutCents);
            pots[category] = Math.max(0, (pots[category] || 0) - paidOutCents);
            gameUpdate = { carryover, pots };
          }
          if (disposition === 'rolled') {
            const deltas = {};
            for (const w of res.winners) {
              if (w.familyId && w.payoutCents > 0) {
                deltas[w.familyId] = (deltas[w.familyId] || 0) + w.payoutCents;
              }
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
          }
        }
      }
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
      if (gameUpdate) tx.update(firestore.doc('state/game'), gameUpdate);
      for (const w of walletWrites) tx.update(w.ref, { balanceCents: w.balanceCents });
      return { walletDeltaCents, paidOutCents };
    });
  }
  throw new Error(`Unknown backup action: ${action}`);
});
