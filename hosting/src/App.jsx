import React, { useEffect, useMemo, useState } from 'react';
import { api, listenGame, listenGameLog, listenWallets, setOrganizerPassword as storePassword, clearOrganizerPassword } from './api';

// Roster — mirrors lib/logic.js (display copy only; all money logic
// runs server-side in the Vercel API).
const ROSTER = [
  { number: 9, name: 'Iannini', family: 'Lauren & Tim' },
  { number: 16, name: 'Keller', family: 'Diane & Brian' },
  { number: 17, name: 'Stanczyk', family: 'Kaley & Travis' },
  { number: 19, name: 'Vrcek', family: 'Cheryl & Mike' },
  { number: 20, name: 'Heichel', family: 'David & Kayla' },
  { number: 22, name: 'Liam', family: 'Trish Adair & Brandon Pecola' },
  { number: 23, name: 'Mohammed', family: 'Sarah Setcavage' },
  { number: 24, name: 'Masula', family: 'Erin & Michael' },
  { number: 29, name: 'H. Boyle', family: 'Lauren & Chris Boyle' },
  { number: 55, name: 'Peters', family: 'Allie & Jeff' },
  { number: 58, name: 'Beatty', family: 'Kahla & Jeffrey' },
  { number: 87, name: 'T. Boyle', family: 'Lauren & Chris Boyle' },
  { number: 88, name: 'Ifft', family: 'Kari & Ben' },
  { number: 94, name: 'Freshwater', family: 'Katlin & Brent' },
  { number: 96, name: 'Olszewski', family: 'Jason Gordon' },
  { number: 98, name: 'Beckett', family: 'Amanda & Brad' },
];

const CATEGORIES = [
  { key: 'firstGoal', label: 'First Goal' },
  { key: 'firstPenalty', label: 'First Penalty' },
  { key: 'playmaker', label: 'Playmaker' },
];

// Show a parent's full name. The stored bettor is often just a first name
// ("Lauren", "Tim") — the family's last name comes from the roster entry for
// the bettor's family (familyId = the kid's jersey number). A name that
// already has a last name ("Trish Adair") and the "Grandparents" group are
// left alone. Family 22 ("Liam") has no last name in the roster — its parents
// already carry full names, so nothing is appended there.
function fullName(buyer, familyId) {
  if (!buyer) return buyer;
  if (buyer === 'Grandparents') return buyer;
  if (String(buyer).trim().includes(' ')) return buyer; // already a full name
  const entry = ROSTER.find((p) => String(p.number) === String(familyId));
  if (!entry || entry.name === 'Liam') return buyer;
  const last = entry.name.split(' ').pop(); // 'H. Boyle' -> 'Boyle', 'Iannini' -> 'Iannini'
  return `${buyer} ${last}`;
}

// The goalies (#29 H. Boyle, #88 Ifft). Who can be picked depends on the
// starting goalie: the goalie in net cannot score (out of First Goal only),
// Harrison does not skate out so he is out of every category when he is the
// backup, and Luke plays as a skater when Harrison is in net so he is in
// all three categories then.
const GOALIES = [29, 88];

// Who can be picked for a category, given the starting goalie and the
// game's scratched players (out of every category).
function inDraw(number, category, startingGoalie, scratched) {
  if (scratched && scratched.includes(number)) return false; // scratched — not playing this game
  if (number === 29 && startingGoalie !== 29) return false; // Harrison is out when he is the backup
  if (category === 'firstGoal' && number === startingGoalie) return false; // goalie in net cannot score
  return true;
}

const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
// How much slush one logged game took in (its payment to Amanda): the slush
// recorded for the game when there is one, otherwise figured from its plays
// — $1 of every $2 category pick is slush, so half of what the plays cost.
// Null when the game has neither recorded slush nor plays to figure from.
const entrySlush = (entry) => {
  if (entry.slushGameCents) return entry.slushGameCents;
  const plays = entry.tickets || [];
  if (!plays.length) return null;
  return plays.reduce((a, t) => a + (t.paidCents || 0), 0) / 2;
};
// Ghost-win odds for the pick screen (Brandon's pick, Nov 14, 2026): how
// often each player has won each category across the logged games, with one
// phantom win added for every player so nobody ever shows 0%:
//   pct = (wins + 1) / (games + roster size)
function playerOdds(log) {
  const entries = log || [];
  const wins = {};
  for (const { key } of CATEGORIES) {
    const byPlayer = new Map();
    for (const entry of entries) {
      const res = entry.resolutions ? entry.resolutions[key] : null;
      if (res && res.playerNumber) byPlayer.set(res.playerNumber, (byPlayer.get(res.playerNumber) || 0) + 1);
    }
    wins[key] = byPlayer;
  }
  return { games: entries.length, wins };
}
const oddsPct = (wins, games) => Math.round((100 * ((wins || 0) + 1)) / (games + ROSTER.length));
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';

function errMsg(err) {
  return (err && err.message) || 'Something went wrong';
}

// The people in a family who can place a bet: the parents, from the
// family's full names ("Trish Adair & Brandon Pecola"), plus "Grandparents"
// when the family label includes them. A first name with no last name
// inherits the family's shared last name ("Lauren & Chris Boyle" ->
// "Lauren Boyle", "Chris Boyle").
function familyMembers(wallet) {
  if (!wallet) return [];
  const parts = String(wallet.family || '')
    .split(/\s*&\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const lastNames = parts.map((p) => {
    const words = p.split(/\s+/);
    return words.length > 1 ? words[words.length - 1] : '';
  });
  const shared = lastNames.find((n) => n) || '';
  const out = parts.map((p) =>
    p.split(/\s+/).length > 1 || !shared ? p : `${p} ${shared}`
  );
  if (/grandparents/i.test(String(wallet.familyLabel || ''))) out.push('Grandparents');
  return out;
}

function PayoutBadge({ disposition }) {
  if (disposition === 'paid') return <span className="badge paid">Paid</span>;
  if (disposition === 'rolled') return <span className="badge rolled">Rolled to account</span>;
  return <span className="badge unmarked">Not paid yet</span>;
}

function TicketCard({ ticket, game, showPayouts, onPayout, odds }) {
  const winnersFor = (cat) => {
    const res = game?.resolutions?.[cat];
    if (!res) return null;
    return res.winners.find((w) => w.ticketId === ticket.id) || null;
  };
  return (
    <div className="ticket">
      <div className="ticket-head">
        <strong>{fullName(ticket.bettor || ticket.buyer, ticket.familyId)}</strong>
        <span className="muted">{ticket.familyLabel}</span>
        <span className="muted small">{ticket.mode === 'physical' ? '🪙 real chip' : '🎲 virtual'}</span>
        {ticket.payLater && <span className="badge warn">Play now pay later</span>}
        <span className="price">Play {money(ticket.paidCents)}</span>
      </div>
      <div className="picks">
        {CATEGORIES.map(({ key, label }) => {
          const pick = ticket.picks?.[key];
          const res = game?.resolutions?.[key];
          const isWinner = res && pick && res.playerNumber === pick.number;
          const w = odds && pick ? odds.wins[key].get(pick.number) || 0 : null;
          return (
            <div key={key} className={`pick ${isWinner ? 'winner' : ''}`}>
              <span className="muted">{label}:</span>{' '}
              {pick ? `#${pick.number} ${pick.name}` : '—'}
              {isWinner && <span className="win-star"> ★ Winner</span>}
              {w !== null && (
                <span className="muted small"> · {oddsPct(w, odds.games)}% · {w} win{w === 1 ? '' : 's'} this season</span>
              )}
            </div>
          );
        })}
      </div>
      {showPayouts && (
        <div className="payouts">
          {CATEGORIES.map(({ key, label }) => {
            const w = winnersFor(key);
            if (!w) return null;
            return (
              <div key={key} className="payout-row">
                <span>
                  {label}: <strong>you owe them {money(w.payoutCents)}</strong> <PayoutBadge disposition={w.disposition} />
                </span>
                {onPayout && (
                  <span className="payout-btns">
                    <button onClick={() => onPayout(key, ticket.id, 'paid')}>Paid — I paid them</button>
                    <button onClick={() => onPayout(key, ticket.id, 'rolled')}>Roll over to account</button>
                    {w.disposition !== 'unmarked' && (
                      <button className="ghost" onClick={() => onPayout(key, ticket.id, 'unmarked')}>Undo</button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function App() {
  const [view, setView] = useState('landing');
  const [game, setGame] = useState(null);
  const [wallets, setWallets] = useState({});
  const [log, setLog] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const u1 = listenGame(setGame);
    const u2 = listenWallets(setWallets);
    const u3 = listenGameLog(setLog);
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);

  const walletList = useMemo(
    () => Object.values(wallets).sort((a, b) => a.family.localeCompare(b.family)),
    [wallets]
  );

  const flash = (msg) => {
    setNotice(msg);
    setError('');
    setTimeout(() => setNotice(''), 5000);
  };
  const fail = (err) => {
    setError(errMsg(err));
    setNotice('');
  };

  return (
    <div className="app">
      <header>
        <h1>🏒 Foxes BY16 Slush Game</h1>
        <p className="muted">Arctic Foxes 10U — $2 per category · half to the pot, half to the slush fund</p>
      </header>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {view !== 'landing' && (
        <button className="ghost" onClick={() => setView('landing')}>← Home</button>
      )}

      {view === 'landing' && (
        <Landing
          game={game}
          log={log}
          onGo={setView}
          onInit={async () => {
            try {
              await api.initApp();
              flash('App seeded — all wallets $0, ready to go.');
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
      {view === 'organizer' && <OrganizerPage game={game} wallets={walletList} log={log} flash={flash} fail={fail} />}
      {view === 'parent' && <ParentPortal game={game} wallets={walletList} log={log} flash={flash} fail={fail} />}
      {view === 'board' && <Board game={game} flash={flash} fail={fail} />}
      {view === 'gamelog' && <GameLogPage log={log} />}
      {view === 'season' && <SeasonPage game={game} log={log} wallets={walletList} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Landing({ game, log, onGo, onInit }) {
  const potFor = (key) =>
    (game?.phase === 'open' || game?.phase === 'closed' ? game.pots?.[key] : game?.carryover?.[key]) || 0;
  // "Running total" = everything collected this season: what is owed to
  // Amanda right now plus what has already been sent to her. Paying Amanda
  // zeroes the amount owed, but it must NOT zero the season total.
  const paidCents = game
    ? (game.slushPayments || []).reduce((sum, p) => sum + (p.amountCents || 0), 0)
    : 0;
  const seasonSlush = game
    ? (game.slushCents || 0) + paidCents
    : log && log[0]
      ? log[0].slushSeasonCents || 0
      : 0;
  // One line per category: who won and how much, then the kid they picked.
  // No colors — parents and grandparents read the same. showAmount=false
  // (the Pots section) leaves the amount off because the pot is already shown.
  const winnerText = (res, showAmount = true) => {
    if (!res) return 'Not decided yet';
    const kid = `#${res.playerNumber} ${res.playerName}`;
    if (!res.winners || res.winners.length === 0) {
      return showAmount
        ? <>Rolled over — {money(res.potCents || 0)} · {kid}</>
        : <>Rolled over · {kid}</>;
    }
    const names = res.winners.map((w, i) => (
      <span key={i}>
        {i > 0 && ', '}
        <strong>{fullName(w.buyer, w.familyId)}</strong>
        {showAmount && <> — {money(w.payoutCents)}</>}
      </span>
    ));
    return (
      <>
        {names} · {kid}
      </>
    );
  };
  return (
    <div className="card">
      <h2>Welcome</h2>
      {game ? (
        <p>
          {game.phase === 'open' || game.phase === 'closed' ? (
            <>
              📅 {fmtDate(game.gameDate)} · Foxes vs {game.opponent || 'TBD'} ·{' '}
              <strong>{game.tickets?.length || 0} {(game.tickets?.length || 0) === 1 ? 'play' : 'plays'}</strong>
              {game.phase === 'closed' ? ' · Draft closed — game in progress' : ''}
            </>
          ) : (
            <>No game open yet — the draft hasn&apos;t started.</>
          )}
        </p>
      ) : (
        <p className="muted">
          The app hasn&apos;t been set up yet. The organizer signs in once and taps “Seed the app” below.
        </p>
      )}
      <p className="slush-total">💰 Slush fund — running total: {money(seasonSlush)}</p>
      <button className="primary parent-hero" onClick={() => onGo('parent')}>Parent Portal</button>
      <p className="muted small" style={{ textAlign: 'center' }}>Parents log in with their kid&apos;s jersey number.</p>
      <button className="nav-hero" onClick={() => onGo('board')}>
        {(game?.phase === 'open' || game?.phase === 'closed')
          ? `Picks for Foxes vs ${game.opponent || 'TBD'}`
          : 'Picks & winners'}
      </button>
      <button className="nav-hero" onClick={() => onGo('season')}>🏆 Season standings</button>
      <button className="nav-hero" onClick={() => onGo('gamelog')}>Game Log</button>
      {log && log.length > 0 && (
        <div>
          <h3>Past games — winners &amp; slush</h3>
          {/* Only the last two games: the log is newest-first, so slice(0, 2).
              Each game gets its own outline color so the two are easy to tell apart. */}
          {log.slice(0, 2).map((entry, i) => (
            <div key={entry.id} className={`pot past-game ${i === 0 ? 'past-game-new' : 'past-game-old'}`}>
              <strong>Foxes vs {entry.opponent || 'TBD'}</strong> · {fmtDate(entry.gameDate)}
              {CATEGORIES.map(({ key, label }) => (
                <div key={key}>
                  <strong>{label}</strong>: {winnerText(entry.resolutions?.[key], true)}
                </div>
              ))}
              {entrySlush(entry) === null
                ? <div>Slush for this game: <strong>not recorded</strong></div>
                : <div>Slush for this game: <strong>{money(entrySlush(entry))}</strong></div>}
            </div>
          ))}
          {log.length > 2 && (
            <p className="muted small">Showing the last 2 games — older games are in the Game Log.</p>
          )}
        </div>
      )}
      {game && (
        <div>
          <h3>Pots{(game.phase === 'open' || game.phase === 'closed') ? ' — this game' : ' — next game (starting amounts)'}</h3>
          <div className="pots">
            {CATEGORIES.map(({ key, label }) => (
              <div key={key} className="pot">
                <strong>{label}</strong>: {money(potFor(key))}
                {(game.phase === 'open' || game.phase === 'closed') && (
                  <span> · Winner: {winnerText(game.resolutions?.[key], false)}</span>
                )}
              </div>
            ))}
          </div>
          {(game.phase === 'open' || game.phase === 'closed') && (
            <p>Slush from this game: <strong>{money(game.slushGameCents || 0)}</strong></p>
          )}
        </div>
      )}
      <button className="nav-hero" onClick={() => onGo('organizer')}>Organizer Page</button>
      {!game && (
        <p>
          <button className="ghost" onClick={onInit}>Seed the app (organizer)</button>
        </p>
      )}
      <p className="muted small">
        Parents log in with their kid&apos;s jersey number. The organizer logs in with the
        organizer password. Winnings are paid out by the organizer — or rolled into the
        family&apos;s account as credit for future plays.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OrganizerPage({ game, wallets, log, flash, fail }) {
  const [pw, setPw] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Start a New Game form
  const [gameDate, setGameDate] = useState(todayStr());
  const [opponent, setOpponent] = useState('');
  const [goalie, setGoalie] = useState(88);
  // Change-goalie fix for an open game: which goalie the organizer has
  // picked in the fix card (null = follow the game's current goalie), and
  // the tap-again arm for its save button.
  const [goaliePick, setGoaliePick] = useState(null);
  const [goalieArm, setGoalieArm] = useState(false);
  const [potInputs, setPotInputs] = useState({ firstGoal: '', firstPenalty: '', playmaker: '' });

  // Bank manager
  const [depFamily, setDepFamily] = useState('');
  const [depAmount, setDepAmount] = useState('');
  const [quickAmounts, setQuickAmounts] = useState({});

  // Who owes (negative wallets), biggest debt first. Moved here from the
  // public Season standings page Nov 14, 2026 — owing money is organizer-only.
  const owing = (wallets || [])
    .filter((w) => (w.balanceCents || 0) < 0)
    .sort((a, b) => a.balanceCents - b.balanceCents);

  // Resolve
  const [resolvePick, setResolvePick] = useState({ firstGoal: '', firstPenalty: '', playmaker: '' });
  // Which category (if any) the organizer is changing after a wrong pick.
  const [changing, setChanging] = useState(null);

  // Scratched players (not playing this game) — multi-select checklist.
  const [scratchSel, setScratchSel] = useState([]);

  // Change password
  const [newPw, setNewPw] = useState('');

  // Fix the books (corrections for money that moved outside the app)
  const [fixSent, setFixSent] = useState('');
  const [fixOwed, setFixOwed] = useState('');
  const [fixKey, setFixKey] = useState('');
  const [fixGameSlush, setFixGameSlush] = useState('');
  const [fixSeasonSlush, setFixSeasonSlush] = useState('');
  const [fixBalances, setFixBalances] = useState({});
  const [fixBalancesInit, setFixBalancesInit] = useState(false);
  // Two-step in-page confirm for the Fix-the-books saves (no native
  // confirm() — some browsers swallow it): first tap arms, second tap saves.
  const [fixArmed, setFixArmed] = useState('');

  useEffect(() => {
    if (game) {
      setGameDate(game.gameDate || todayStr());
      setOpponent(game.opponent || '');
      if (game.startingGoalie) setGoalie(game.startingGoalie);
      setPotInputs({
        firstGoal: game.carryover ? String((game.carryover.firstGoal || 0) / 100) : '',
        firstPenalty: game.carryover ? String((game.carryover.firstPenalty || 0) / 100) : '',
        playmaker: game.carryover ? String((game.carryover.playmaker || 0) / 100) : '',
      });
      setFixSent(String(((game.slushPayments || []).reduce((s, p) => s + (p.amountCents || 0), 0)) / 100));
      setFixOwed(String((game.slushCents || 0) / 100));
    }
  }, [game?.gameId]);

  // Keep the scratch checklist in step with the saved scratches — keyed on
  // the list itself so unrelated game updates don't wipe a half-done edit.
  useEffect(() => {
    setScratchSel(game?.scratched || []);
  }, [JSON.stringify(game?.scratched || [])]);

  // Fill the Fix-the-books balance boxes once, from the live wallets.
  useEffect(() => {
    if (!fixBalancesInit && wallets && wallets.length) {
      const init = {};
      for (const w of wallets) init[w.familyId] = String((w.balanceCents || 0) / 100);
      setFixBalances(init);
      setFixBalancesInit(true);
    }
  }, [wallets, fixBalancesInit]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    try {
      await api.organizerLogin(pw);
      storePassword(pw);
      setLoggedIn(true);
      setPw('');
      flash('Organizer signed in.');
    } catch (e) {
      fail(e);
    }
  };

  if (!game) return <div className="card"><p>Loading… (if this stays blank, the organizer still needs to seed the app from the home screen.)</p></div>;

  if (!loggedIn) {
    return (
      <div className="card">
        <h2>Organizer sign-in</h2>
        <p className="muted">Enter the organizer password to manage games, deposits and payouts.</p>
        <input type="password" placeholder="Organizer password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
        <button onClick={login}>Sign in</button>
      </div>
    );
  }

  const unmarkedWinners = CATEGORIES.flatMap(({ key }) => {
    const res = game.resolutions?.[key];
    return res ? res.winners.filter((w) => w.disposition === 'unmarked') : [];
  });

  // Every winner across all resolved categories, for the "Who to pay"
  // summary: who won, what they won, and how much to hand them.
  const allWinners = CATEGORIES.flatMap(({ key, label }) => {
    const res = game.resolutions?.[key];
    return res ? res.winners.map((w) => ({ ...w, category: key, categoryLabel: label })) : [];
  });
  const totalOwedCents = allWinners
    .filter((w) => w.disposition === 'unmarked')
    .reduce((sum, w) => sum + (w.payoutCents || 0), 0);

  const saveDetails = async () => {
    await run(async () => {
      await api.setGameInfo(gameDate || null, opponent.trim() || null);
      flash('Game details saved.');
    });
  };

  const savePot = async (key) => {
    const dollars = parseFloat(potInputs[key]);
    if (Number.isNaN(dollars) || dollars < 0) return fail(new Error('Enter a valid dollar amount'));
    await run(async () => {
      await api.setCarryover(key, Math.round(dollars * 100));
      flash(`${CATEGORIES.find((c) => c.key === key).label} starting pot set to $${dollars.toFixed(2)}.`);
    });
  };

  const startGame = async () => {
    await run(async () => {
      await api.openGame(gameDate || null, opponent.trim() || null, goalie);
      flash(`Game started — Foxes vs ${opponent || 'TBD'}. The draft is open.`);
    });
  };

  // Close the draft once the real game starts — no more plays, but the
  // game can still be resolved after it ends.
  const closeDraft = async () => {
    await run(async () => {
      await api.closeDraft();
      flash('Draft closed — the game has started. No more plays.');
    });
  };

  const reopenDraft = async () => {
    await run(async () => {
      await api.reopenDraft();
      flash('Draft reopened — parents can buy plays again.');
    });
  };

  // One-time fix for a game opened before a deck rule changed: rebuilds all
  // three decks from the current starting goalie, keeping drawn cards out.
  const rebuildDecks = async () => {
    await run(async () => {
      const out = (await api.rebuildDecks()).data;
      flash(`Decks fixed — First Goal ${out.firstGoal.after} left, First Penalty ${out.firstPenalty.after} left, Playmaker ${out.playmaker.after} left.`);
    });
  };

  // Fix a wrong starting-goalie pick on an open game: the decks rebuild
  // around the new goalie; plays already sold stay as they are (any that no
  // longer fit are named in the warning). Two-step confirm, like Fix the
  // books — native confirm() dialogs don't work in the automated browser.
  const changeGoalie = async () => {
    const target = goaliePick ?? game.startingGoalie;
    if (!goalieArm) {
      setGoalieArm(true);
      flash(`Check, then tap again to confirm: starting goalie becomes #${target}. The decks rebuild around him — plays already sold stay as they are.`);
      return;
    }
    setGoalieArm(false);
    await run(async () => {
      const out = (await api.setStartingGoalie(target)).data;
      setGoaliePick(null);
      let msg = `Starting goalie changed to #${out.startingGoalie} — First Goal ${out.decks.firstGoal.after} cards, First Penalty ${out.decks.firstPenalty.after}, Playmaker ${out.decks.playmaker.after}.`;
      if (out.conflicts && out.conflicts.length) {
        const label = (n) => `#${n} ${ROSTER.find((p) => p.number === n)?.name || ''}`;
        const catLabel = (k) => CATEGORIES.find((c) => c.key === k)?.label || k;
        msg += ` Warning — sold picks that no longer fit (they stay as they are): ${out.conflicts.map((c) => `${c.bettor} has ${label(c.playerNumber)} in ${catLabel(c.category)}`).join('; ')}.`;
      }
      flash(msg);
    });
  };

  // Shared by the open and closed cards: the change-goalie fix block.
  const goalieSel = goaliePick ?? game?.startingGoalie;
  const goalieFixBlock = game ? (
    <div>
      <h3>Starting goalie</h3>
      <p className="muted small">Opened with the wrong goalie? Change him here — the decks rebuild around the new goalie. Plays already sold stay as they are.</p>
      <label><input type="radio" name="goalie-fix" checked={goalieSel === 29} onChange={() => { setGoaliePick(29); setGoalieArm(false); }} /> #29 H. Boyle</label>
      <label><input type="radio" name="goalie-fix" checked={goalieSel === 88} onChange={() => { setGoaliePick(88); setGoalieArm(false); }} /> #88 Ifft</label>
      <p>
        <button className="ghost" onClick={changeGoalie} disabled={busy || goalieSel === game.startingGoalie}>
          {goalieArm ? 'Tap again to confirm' : 'Change goalie & rebuild decks'}
        </button>{' '}
        <span className="muted small">Now: #{game.startingGoalie} in net.</span>
      </p>
    </div>
  ) : null;

  const toggleScratch = (n) =>
    setScratchSel((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));

  // Save who's out for this game. Scratched players leave every deck and
  // can't be picked or named a winner; plays already sold stay as they are.
  const saveScratches = async () => {
    await run(async () => {
      const out = (await api.setScratched(scratchSel)).data;
      const label = (n) => `#${n} ${ROSTER.find((p) => p.number === n)?.name || ''}`;
      let msg = out.scratched.length
        ? `Scratched: ${out.scratched.map(label).join(', ')} — they can't be picked this game.`
        : 'Scratches cleared — everyone is in.';
      if (out.alreadyPicked && out.alreadyPicked.length) {
        msg += ` Heads up: ${out.alreadyPicked.map(label).join(', ')} already had plays sold — those plays stay as they are.`;
      }
      flash(msg);
    });
  };

  const deposit = async () => {
    const dollars = parseFloat(depAmount);
    if (!depFamily || Number.isNaN(dollars) || dollars <= 0) return fail(new Error('Pick a family and enter an amount over $0'));
    await run(async () => {
      await api.deposit(depFamily, Math.round(dollars * 100));
      flash(`Deposited $${dollars.toFixed(2)}.`);
      setDepAmount('');
    });
  };

  // One-tap cash deposit for when a parent hands you cash at the rink.
  // Confirms the family first, since there is no undo for a deposit.
  const quickDeposit = async (familyId, dollars) => {
    const w = wallets.find((x) => x.familyId === familyId);
    if (!w) return;
    if (!window.confirm(`Add $${dollars.toFixed(2)} cash to ${w.familyLabel}?`)) return;
    await run(async () => {
      await api.deposit(familyId, Math.round(dollars * 100));
      flash(`Deposited $${dollars.toFixed(2)} cash to ${w.familyLabel}.`);
    });
  };

  const quickDepositCustom = async (familyId) => {
    const w = wallets.find((x) => x.familyId === familyId);
    if (!w) return;
    const dollars = parseFloat(quickAmounts[familyId]);
    if (Number.isNaN(dollars) || dollars <= 0) return fail(new Error('Enter an amount over $0'));
    if (!window.confirm(`Add $${dollars.toFixed(2)} cash to ${w.familyLabel}?`)) return;
    let ok = false;
    await run(async () => {
      await api.deposit(familyId, Math.round(dollars * 100));
      ok = true;
      flash(`Deposited $${dollars.toFixed(2)} cash to ${w.familyLabel}.`);
    });
    if (ok) setQuickAmounts((prev) => ({ ...prev, [familyId]: '' }));
  };

  const resolve = async (key) => {
    const num = parseInt(resolvePick[key], 10);
    if (!num) return fail(new Error('Pick a player first'));
    const wasResolved = !!game.resolutions?.[key];
    await run(async () => {
      const { resolution } = (await api.resolveCategory(key, num)).data;
      setChanging(null);
      const verb = wasResolved ? 'changed' : 'resolved';
      if (resolution.winners.length === 0) {
        flash(`${CATEGORIES.find((c) => c.key === key).label} ${verb} — nobody picked #${num}, so the ${money(resolution.potCents)} pot rolls over.`);
      } else {
        flash(`${CATEGORIES.find((c) => c.key === key).label} ${verb} — ${resolution.winners.length} winner(s), ${money(resolution.potCents)} pot.`);
      }
    });
  };

  const payout = async (key, ticketId, disposition) => {
    await run(async () => {
      await api.setPayout(key, ticketId, disposition);
      flash(disposition === 'rolled' ? 'Rolled to the family account.' : disposition === 'paid' ? 'Marked as paid.' : 'Payout choice cleared.');
    });
  };

  const reset = async () => {
    const warn = unmarkedWinners.length
      ? `\n\nWARNING: ${unmarkedWinners.length} winner(s) still marked "Not paid yet". They will be saved to the Game Log as unpaid.`
      : '';
    if (!window.confirm(`End this game? It will be saved to the Game Log first, then the game clears.${warn}`)) return;
    await run(async () => {
      const { logged } = (await api.resetGame()).data;
      flash(logged ? 'Game saved to the log. Ready for the next game.' : 'Nothing to log — back at setup.');
    });
  };

  const factoryReset = async () => {
    if (!window.confirm('FACTORY RESET — this wipes EVERYTHING: plays, pots, carryovers, slush, all wallets to $0, and the whole Game Log. The organizer password stays the same. Are you sure?')) return;
    if (!window.confirm('Really sure? There is no undo.')) return;
    await run(async () => {
      await api.factoryReset();
      flash('App wiped back to a clean slate.');
    });
  };

  // Download the whole season as one backup file: wallets, the current
  // game, slush, payments to Amanda, and the full Game Log.
  const downloadBackup = async () => {
    await run(async () => {
      const { backup } = (await api.exportBackup()).data;
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `foxes-slush-backup-${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flash(`Backup downloaded — ${backup.log.length} game(s) in the log, ${Object.keys(backup.wallets).length} wallets, slush owed ${money(backup.slushCents)}. Keep the file somewhere safe.`);
    });
  };

  // Restore a backup file: replaces everything in the app with the file's
  // contents. The organizer password is not part of a backup.
  const restoreBackup = async (file) => {
    if (!file) return;
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      return fail(new Error('That file could not be read as a backup.'));
    }
    if (!window.confirm('RESTORE this backup? It replaces EVERYTHING in the app right now — wallets, the current game, slush, and the whole Game Log — with what is in the file.')) return;
    if (!window.confirm('Really sure? Download a backup of the current data first if you might want it back.')) return;
    await run(async () => {
      const out = (await api.restoreBackup(backup)).data;
      flash(`Backup restored — ${out.gamesRestored} game(s) in the log, ${out.walletsRestored} wallets, slush owed ${money(out.slushCents)}.`);
    });
  };

  // Import games into the Game Log from a file (a list of game records,
  // e.g. older games rebuilt from the old pool dashboard). Add-only:
  // games already in the log (same date and opponent) are skipped, and
  // wallets, slush and the current game are never touched.
  const doImport = async (entries) => {
    if (!window.confirm(`Import ${entries.length} game(s) into the Game Log? Games already logged (same date and opponent) are skipped. Wallets, slush and the current game are not touched.`)) return;
    await run(async () => {
      const out = (await api.importLog(entries)).data;
      flash(`Imported ${out.imported} game(s) into the Game Log${out.skipped ? ` — ${out.skipped} already there, skipped` : ''}.`);
    });
  };
  const importGames = async (file) => {
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return fail(new Error('That file could not be read as game records.'));
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.entries || parsed.log;
    if (!Array.isArray(entries) || entries.length === 0) {
      return fail(new Error('That file has no games in it.'));
    }
    await doImport(entries);
  };
  // The season's first 13 games (Aug 30 – Nov 14), rebuilt from the old
  // pool dashboard and bundled with the app — one tap, no file to handle.
  const loadDashboardGames = async () => {
    await run(async () => {
      const res = await fetch('/dashboard-import.json');
      if (!res.ok) throw new Error('Could not load the dashboard games file.');
      const entries = await res.json();
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('The dashboard games file is empty.');
      await doImport(entries);
    });
  };
  // The full pick lists for the 12 older dashboard games (everyone's chip
  // picks, pulled from the dashboard's dated chip pages) — fills in who
  // picked what so the season standings count every play, not just today's.
  const loadPickLists = async () => {
    await run(async () => {
      const res = await fetch('/dashboard-tickets.json');
      if (!res.ok) throw new Error('Could not load the pick lists file.');
      const data = await res.json();
      const games = Array.isArray(data) ? data : data.games;
      if (!Array.isArray(games) || games.length === 0) throw new Error('The pick lists file is empty.');
      const r = (await api.setLogTickets(games)).data || {};
      flash(r.skipped && r.skipped.length
        ? `Pick lists loaded for ${r.updated} games. Skipped: ${r.skipped.join(', ')}`
        : `Pick lists loaded for ${r.updated} games — the season standings now count every play.`);
    });
  };

  // Fix the books: correct the season slush position — money that moved
  // outside the app (e.g. cash handed to Amanda before the app tracked it).
  const saveSlushFix = async () => {
    const sentCents = Math.round(parseFloat(fixSent || '0') * 100);
    const owedCents = Math.round(parseFloat(fixOwed || '0') * 100);
    if (!Number.isFinite(sentCents) || !Number.isFinite(owedCents) || sentCents < 0 || owedCents < 0) {
      return fail(new Error('Slush amounts must be $0 or more.'));
    }
    if (fixArmed !== 'slush') {
      setFixArmed('slush');
      flash(`Check, then tap "Save slush numbers" again to confirm: ${money(sentCents)} already sent to Amanda, ${money(owedCents)} still owed — the home-page running total becomes ${money(sentCents + owedCents)}.`);
      return;
    }
    setFixArmed('');
    await run(async () => {
      await api.setSlush(owedCents, sentCents);
      flash(`Slush corrected — ${money(sentCents)} sent to Amanda, ${money(owedCents)} still owed.`);
    });
  };

  // Fix the books: correct one logged game — a winner who was marked paid
  // but actually rolled (or the reverse), and/or the slush that game took in.
  const fixEntry = (log || []).find((e) => `${e.gameDate}|${e.opponent}` === fixKey) || null;
  const pickFixGame = (key) => {
    setFixKey(key);
    const e = (log || []).find((x) => `${x.gameDate}|${x.opponent}` === key);
    setFixGameSlush(e ? String((e.slushGameCents || 0) / 100) : '');
    setFixSeasonSlush(e ? String((e.slushSeasonCents || 0) / 100) : '');
  };
  const flipWinner = async (entry, category, winner, disposition) => {
    const label = disposition === 'rolled' ? 'rolled into their account' : 'paid';
    const armKey = `flip:${category}:${winner.buyer}`;
    if (fixArmed !== armKey) {
      setFixArmed(armKey);
      flash(`Check, then tap the same button again to confirm: ${winner.buyer}'s ${money(winner.payoutCents)} win vs ${entry.opponent} marked ${label} — their family wallet ${disposition === 'rolled' ? 'gains' : 'loses'} ${money(winner.payoutCents)}.`);
      return;
    }
    setFixArmed('');
    await run(async () => {
      await api.fixLogGame({ gameDate: entry.gameDate, opponent: entry.opponent, category, disposition });
      flash(`${winner.buyer}'s win vs ${entry.opponent} marked ${label}.`);
    });
  };
  const saveGameSlushFix = async () => {
    if (!fixEntry) return;
    const g = Math.round(parseFloat(fixGameSlush || '0') * 100);
    const s = Math.round(parseFloat(fixSeasonSlush || '0') * 100);
    if (!Number.isFinite(g) || !Number.isFinite(s) || g < 0 || s < 0) {
      return fail(new Error('Slush amounts must be $0 or more.'));
    }
    await run(async () => {
      await api.fixLogGame({ gameDate: fixEntry.gameDate, opponent: fixEntry.opponent, slushGameCents: g, slushSeasonCents: s });
      flash(`Slush for the ${fixEntry.opponent} game set to ${money(g)} (season ${money(s)}).`);
    });
  };
  const saveWalletFix = async () => {
    const balances = {};
    for (const w of wallets) {
      const raw = fixBalances[w.familyId];
      if (raw === undefined || raw === '') continue;
      const cents = Math.round(parseFloat(raw) * 100);
      if (!Number.isFinite(cents)) return fail(new Error(`That balance for ${w.familyLabel} is not a number.`));
      balances[w.familyId] = cents;
    }
    if (!Object.keys(balances).length) return fail(new Error('No balances to save.'));
    if (fixArmed !== 'wallets') {
      setFixArmed('wallets');
      flash(`Check, then tap "Save all balances" again to confirm: set ${Object.keys(balances).length} wallet balance(s) to exactly the amounts shown, replacing the current balances.`);
      return;
    }
    setFixArmed('');
    await run(async () => {
      const out = (await api.setWallets(balances)).data;
      flash(`${out.updated} wallet balance(s) set.`);
    });
  };

  const payAmanda = async () => {
    if (!game.slushCents || game.slushCents <= 0) return;
    if (!window.confirm(`Send ${money(game.slushCents)} to Amanda? This marks the slush as paid and resets the amount owed to $0.`)) return;
    await run(async () => {
      const { paidCents } = (await api.payAmanda()).data;
      flash(`Sent ${money(paidCents)} to Amanda.`);
    });
  };

  const setDrawMode = async (drawMode) => {
    await run(async () => {
      await api.setDrawMode(drawMode);
      flash(
        drawMode === 'mixed'
          ? 'Draw mode set — parents pick virtual or real chips per play.'
          : drawMode === 'physical'
            ? 'Draw mode set — this game uses real chips only.'
            : 'Draw mode set — this game uses the virtual draw only.'
      );
    });
  };

  const drawMode = game.drawMode || 'mixed';

  return (
    <div>
      <div className="card">
        <h2>Organizer</h2>
        <p className="muted">
          {game.phase === 'open'
            ? `Game open: ${fmtDate(game.gameDate)} · Foxes vs ${game.opponent || 'TBD'} · Goalie #${game.startingGoalie}`
            : game.phase === 'closed'
              ? `Draft closed — game in progress: ${fmtDate(game.gameDate)} · Foxes vs ${game.opponent || 'TBD'} · Goalie #${game.startingGoalie}`
              : 'No game open — set up the next game below.'}{' '}
          Season slush owed to Amanda: <strong>{money(game.slushCents)}</strong>
        </p>
        <button className="ghost" onClick={() => { clearOrganizerPassword(); window.location.reload(); }}>Sign out</button>
      </div>

      {game.phase === 'setup' && (
        <div className="card">
          <h2>Start a New Game</h2>
          <h3>Step 1 — Date &amp; opponent</h3>
          <label>Date <input type="date" value={gameDate} onChange={(e) => setGameDate(e.target.value)} /></label>
          <label>Opponent <input type="text" placeholder="e.g. Johnstown" value={opponent} onChange={(e) => setOpponent(e.target.value)} /></label>
          <button onClick={saveDetails} disabled={busy}>Save Game Details</button>

          <h3>Step 2 — Starting goalie</h3>
          <label><input type="radio" name="goalie" checked={goalie === 29} onChange={() => setGoalie(29)} /> #29 H. Boyle</label>
          <label><input type="radio" name="goalie" checked={goalie === 88} onChange={() => setGoalie(88)} /> #88 Ifft</label>

          <h3>Step 3 — Rollover</h3>
          <p className="muted small">These are the pots rolling over from the last game — they fill in automatically. Edit them here if the real amount is different.</p>
          {CATEGORIES.map(({ key, label }) => (
            <div key={key} className="row">
              <label>{label} <input type="number" min="0" step="0.01" value={potInputs[key]} onChange={(e) => setPotInputs({ ...potInputs, [key]: e.target.value })} /></label>
              <button onClick={() => savePot(key)} disabled={busy}>Set</button>
            </div>
          ))}

          <h3>Step 4 — Open the draft</h3>
          <button className="primary" onClick={startGame} disabled={busy}>Start Game — Lock Roster &amp; Open Draft</button>
        </div>
      )}

      {game.phase === 'open' && (
        <div className="card">
          <h2>Draft Open — fix details</h2>
          <label>Date <input type="date" value={gameDate} onChange={(e) => setGameDate(e.target.value)} /></label>
          <label>Opponent <input type="text" value={opponent} onChange={(e) => setOpponent(e.target.value)} /></label>
          <button onClick={saveDetails} disabled={busy}>Save Game Details</button>
          {goalieFixBlock}
          <div>
            <h3>Fix the decks</h3>
            <p className="muted small">If this game was opened before a deck rule changed, tap to rebuild the decks from the starting goalie. Cards already drawn stay drawn.</p>
            <button className="ghost" onClick={rebuildDecks} disabled={busy}>Fix the decks</button>
          </div>
          <h3>Close the draft</h3>
          <p className="muted small">Once the real game starts, close the draft so no more plays can be bought. You can still resolve the game after it ends.</p>
          <button className="primary" onClick={closeDraft} disabled={busy}>Close the draft — game is starting</button>
        </div>
      )}

      {game.phase === 'closed' && (
        <div className="card">
          <h2>Draft closed — game in progress</h2>
          <p className="muted">No more plays can be bought. Resolve the game below once it ends, or reopen the draft if you closed it early.</p>
          <button className="ghost" onClick={reopenDraft} disabled={busy}>Reopen draft</button>
          {goalieFixBlock}
        </div>
      )}

      <div className="card">
        <h2>Scratched players — out for this game</h2>
        <p className="muted small">Tap anyone who isn&apos;t playing today (sick, hurt, not dressing) — as many as you need. They&apos;re removed from every category, can&apos;t be picked, and can&apos;t be named a winner. Then tap Save scratches.</p>
        <div className="deck">
          {ROSTER.map((p) => (
            <button key={p.number} className={scratchSel.includes(p.number) ? 'picked' : ''} onClick={() => toggleScratch(p.number)} disabled={busy}>
              #{p.number} {p.name}{scratchSel.includes(p.number) ? ' — OUT' : ''}
            </button>
          ))}
        </div>
        <p>
          <button className="primary" onClick={saveScratches} disabled={busy}>Save scratches</button>{' '}
          <span className="muted small">{scratchSel.length ? `${scratchSel.length} out: ${scratchSel.map((n) => `#${n}`).join(', ')}` : 'Nobody scratched.'}</span>
        </p>
      </div>

      <div className="card">
        <h2>Draw mode</h2>
        <p className="muted small">Pick how this game&apos;s draft runs. Parents only get the option you set here.</p>
        <div className="row">
          <button className={drawMode === 'virtual' ? 'primary' : ''} onClick={() => setDrawMode('virtual')} disabled={busy}>🎲 Virtual draw</button>
          <button className={drawMode === 'physical' ? 'primary' : ''} onClick={() => setDrawMode('physical')} disabled={busy}>🪙 Real chips</button>
          <button className={drawMode === 'mixed' ? 'primary' : ''} onClick={() => setDrawMode('mixed')} disabled={busy}>Let parents choose</button>
        </div>
        <p className="muted small">
          {drawMode === 'virtual'
            ? 'Now: virtual draw only — parents tap the face-down cards in the app.'
            : drawMode === 'physical'
              ? 'Now: real chips only — parents draw a chip from the bag, then tap the player they got.'
              : 'Now: parents pick virtual or real chips per play.'}
        </p>
      </div>

      <div className="card">
        <h2>Who owes</h2>
        {owing.length === 0 ? (
          <p className="muted">Nobody owes anything — every wallet is square. 🎉</p>
        ) : (
          owing.map((w) => (
            <div key={w.familyId} className="pick-row">
              <span>{w.familyLabel}</span>
              <span className="negative"><strong>owes {money(-(w.balanceCents || 0))}</strong></span>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Bank Manager — deposits</h2>
        <p className="muted small">Take cash/Venmo from a family, then top up their wallet here.</p>
        <div className="row">
          <select value={depFamily} onChange={(e) => setDepFamily(e.target.value)}>
            <option value="">Pick a family…</option>
            {wallets.map((w) => (
              <option key={w.familyId} value={w.familyId}>{w.familyLabel} — {money(w.balanceCents)}</option>
            ))}
          </select>
          <input type="number" min="0" step="0.01" placeholder="$ amount" value={depAmount} onChange={(e) => setDepAmount(e.target.value)} />
          <button onClick={deposit} disabled={busy}>Deposit</button>
        </div>
        <div className="wallet-grid">
          {wallets.map((w) => (
            <div key={w.familyId} className="wallet-chip">
              {w.familyLabel}: <strong className={w.balanceCents < 0 ? 'negative' : ''}>{money(w.balanceCents)}</strong>{w.balanceCents < 0 ? ' — owes' : ''}{' '}
              <button className="ghost" onClick={() => quickDeposit(w.familyId, 6)} disabled={busy}>+$6</button>{' '}
              <button className="ghost" onClick={() => quickDeposit(w.familyId, 10)} disabled={busy}>+$10</button>{' '}
              <button className="ghost" onClick={() => quickDeposit(w.familyId, 20)} disabled={busy}>+$20</button>{' '}
              <input
                type="number" min="0" step="0.01" placeholder="$" aria-label={`Custom cash amount for ${w.familyLabel}`}
                value={quickAmounts[w.familyId] || ''}
                onChange={(e) => setQuickAmounts((prev) => ({ ...prev, [w.familyId]: e.target.value }))}
                className="quick-amount"
              />
              <button className="ghost" onClick={() => quickDepositCustom(w.familyId)} disabled={busy}>Add</button>
            </div>
          ))}
        </div>
        <p className="muted small">Quick cash: tap +$6, +$10, or +$20 next to a family when they hand you cash at the rink, or type any amount in the $ box and tap Add. Use the form above for a deposit without the quick buttons.</p>
      </div>

      {(game.phase === 'open' || game.phase === 'closed') && (
        <div className="card">
          <h2>Resolve the game</h2>
          {CATEGORIES.map(({ key, label }) => {
            const res = game.resolutions?.[key];
            return (
              <div key={key} className="resolve-row">
                <strong>{label}</strong> — pot {money(game.pots?.[key] || 0)}
                {res && changing !== key ? (
                  <span>
                    {' '}→ #{res.playerNumber} {res.playerName} ·{' '}
                    {res.winners.length === 0 ? (
                      <span className="badge rolled">Nobody picked — rollover</span>
                    ) : (
                      <span>{res.winners.length} winner(s), {money(res.potCents)} pot</span>
                    )}
                    {' '}
                    <button className="ghost" onClick={() => { setResolvePick({ ...resolvePick, [key]: String(res.playerNumber) }); setChanging(key); }}>Change</button>
                  </span>
                ) : (
                  <span className="row">
                    <select value={resolvePick[key]} onChange={(e) => setResolvePick({ ...resolvePick, [key]: e.target.value })}>
                      <option value="">Who scored / took it? …</option>
                      {ROSTER.filter((p) => inDraw(p.number, key, game.startingGoalie, game.scratched)).map((p) => (
                        <option key={p.number} value={p.number}>#{p.number} {p.name}</option>
                      ))}
                    </select>
                    <button onClick={() => resolve(key)} disabled={busy}>{res ? `Update ${label}` : `Resolve ${label}`}</button>
                    {res && <button className="ghost" onClick={() => setChanging(null)}>Cancel</button>}
                  </span>
                )}
              </div>
            );
          })}

          <h3>Winners &amp; payouts</h3>
          {allWinners.length > 0 && (
            <div className="card payout-summary">
              <h3>Who to pay</h3>
              {allWinners.map((w, i) => (
                <div key={`${w.category}-${w.ticketId}-${i}`} className="payout-summary-row">
                  <div className="payout-summary-line">
                    <span><strong>{fullName(w.buyer, w.familyId)}</strong> — {w.categoryLabel}</span>
                    <span><strong>{money(w.payoutCents)}</strong> <PayoutBadge disposition={w.disposition} /></span>
                  </div>
                  <div className="payout-btns">
                    <button onClick={() => payout(w.category, w.ticketId, 'paid')}>Paid — I paid them</button>
                    <button onClick={() => payout(w.category, w.ticketId, 'rolled')}>Roll over to account</button>
                    {w.disposition !== 'unmarked' && (
                      <button className="ghost" onClick={() => payout(w.category, w.ticketId, 'unmarked')}>Undo</button>
                    )}
                  </div>
                </div>
              ))}
              <div className="payout-summary-total">
                <span>Total to pay out</span>
                <strong>{money(totalOwedCents)}</strong>
              </div>
              {totalOwedCents === 0 && <p className="muted small">Everyone is settled — nothing left to hand out.</p>}
            </div>
          )}
          {(game.tickets || []).length === 0 && <p className="muted">No plays yet.</p>}

          <h3>End the game</h3>
          {unmarkedWinners.length > 0 && (
            <p className="warn">⚠️ {unmarkedWinners.length} winner(s) still “Not paid yet”. Mark them paid or rolled before resetting, or they’ll be logged as unpaid.</p>
          )}
          <button className="primary" onClick={reset} disabled={busy}>Reset Game — save to log &amp; start fresh</button>
        </div>
      )}

      <div className="card">
        <h2>Send to Amanda</h2>
        <p>Season slush owed to Amanda: <strong>{money(game.slushCents)}</strong></p>
        {game.slushCents > 0 ? (
          <button className="primary" onClick={payAmanda} disabled={busy}>Send {money(game.slushCents)} to Amanda</button>
        ) : (
          <p className="muted">Nothing owed right now.</p>
        )}
      </div>

      <div className="card">
        <h2>Paid to Amanda</h2>
        {(game.slushPayments || []).length > 0 ? (
          (game.slushPayments || []).map((p, i) => (
            <div key={i}>{money(p.amountCents)} — {new Date(p.paidAt).toLocaleDateString()}</div>
          ))
        ) : (
          <p className="muted">No payments to Amanda yet.</p>
        )}
      </div>

      <div className="card">
        <h2>Fix the books</h2>
        <p className="muted small">For money that moved outside the app — cash already handed to Amanda, or a winner who rolled instead of taking cash. Corrections here rewrite the recorded numbers to match.</p>
        <h3>Season slush</h3>
        <label>Already sent to Amanda, all season $ <input type="number" min="0" step="0.01" value={fixSent} onChange={(e) => setFixSent(e.target.value)} /></label>
        <label>Still owed to Amanda $ <input type="number" min="0" step="0.01" value={fixOwed} onChange={(e) => setFixOwed(e.target.value)} /></label>
        <p><button className="primary" onClick={saveSlushFix} disabled={busy}>{fixArmed === 'slush' ? 'Tap again to confirm' : 'Save slush numbers'}</button></p>
        <h3>A logged game</h3>
        <label>Game{' '}
          <select value={fixKey} onChange={(e) => pickFixGame(e.target.value)}>
            <option value="">Pick a game…</option>
            {(log || []).map((e) => (
              <option key={e.id || `${e.gameDate}|${e.opponent}`} value={`${e.gameDate}|${e.opponent}`}>{fmtDate(e.gameDate)} · Foxes vs {e.opponent}</option>
            ))}
          </select>
        </label>
        {fixEntry && (
          <div>
            {CATEGORIES.map(({ key, label }) => {
              const res = fixEntry.resolutions && fixEntry.resolutions[key];
              const winners = (res && res.winners) || [];
              return winners.filter((w) => w && w.buyer).map((w, i) => (
                <p key={`${key}-${i}`} className="small">
                  {label}: <strong>{w.buyer}</strong> — {money(w.payoutCents)} — {w.disposition === 'rolled' ? 'in their account' : 'paid'}{' '}
                  <button className="ghost" disabled={busy} onClick={() => flipWinner(fixEntry, key, w, w.disposition === 'rolled' ? 'paid' : 'rolled')}>
                    {fixArmed === `flip:${key}:${w.buyer}` ? 'Tap again to confirm' : `Mark as ${w.disposition === 'rolled' ? 'paid' : 'rolled into their account'}`}
                  </button>
                </p>
              ));
            })}
            <label>Slush collected this game $ <input type="number" min="0" step="0.01" value={fixGameSlush} onChange={(e) => setFixGameSlush(e.target.value)} /></label>
            <label>Season slush total after this game $ <input type="number" min="0" step="0.01" value={fixSeasonSlush} onChange={(e) => setFixSeasonSlush(e.target.value)} /></label>
            <p><button onClick={saveGameSlushFix} disabled={busy}>Save this game&apos;s slush</button></p>
          </div>
        )}
        <h3>Wallet balances</h3>
        <p className="muted small">Every family&apos;s exact balance — negative means they owe. Saving replaces all of them at once, so the app can be matched to the old app in one pass.</p>
        {wallets.map((w) => (
          <label key={w.familyId} className="small">{w.familyLabel} $ <input type="number" step="0.01" value={fixBalances[w.familyId] ?? ''} onChange={(e) => setFixBalances({ ...fixBalances, [w.familyId]: e.target.value })} /></label>
        ))}
        <p><button className="primary" onClick={saveWalletFix} disabled={busy}>{fixArmed === 'wallets' ? 'Tap again to confirm' : 'Save all balances'}</button></p>
      </div>

      <div className="card">
        <h2>Backup &amp; restore</h2>
        <p className="muted small">Download a backup of the whole season — every wallet, the current game, slush, payments to Amanda, and the full Game Log — as one file. If the app ever gets wiped, restore the file here and everything comes back. The organizer password is never part of a backup.</p>
        <p>
          <button className="primary" onClick={downloadBackup} disabled={busy}>Download backup</button>
        </p>
        <h3>Restore from a backup file</h3>
        <p className="muted small">Restoring replaces everything in the app right now with the file&apos;s contents. Download a backup of the current data first if you might want it back.</p>
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            restoreBackup(f);
          }}
        />
        <h3>Import games into the Game Log</h3>
        <p className="muted small">The season&apos;s first 13 games (Aug 30 – Nov 14) from the old pool dashboard are bundled with the app — one tap loads them, no file to handle:</p>
        <p>
          <button className="primary" onClick={loadDashboardGames} disabled={busy}>Load the 13 dashboard games</button>
        </p>
        <p className="muted small">Already loaded those games? Add everyone&apos;s chip picks for the 12 older games, so the season standings count every play (winners, pots and balances don&apos;t change; safe to tap more than once):</p>
        <p>
          <button className="primary" onClick={loadPickLists} disabled={busy}>Load the pick lists for the 12 older games</button>
        </p>
        <p className="muted small">Or add games from a game-records file. Importing only adds to the Game Log — games already logged are skipped, and wallets, slush and the current game are never touched.</p>
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            importGames(f);
          }}
        />
      </div>

      <div className="card danger-zone">
        <h2>Factory reset</h2>
        <p className="muted small">Wipes plays, pots, carryovers, slush, all wallets to $0, and the whole Game Log. The organizer password stays the same.</p>
        <div className="factory-reset">
          <button className="danger danger-small" onClick={factoryReset} disabled={busy}>Factory reset — wipe everything</button>
        </div>
        <h3>Change organizer password</h3>
        <input type="password" placeholder="New password (min 4 chars)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <button
          onClick={() => run(async () => {
            await api.changeOrganizerPassword(newPw);
            storePassword(newPw);
            setNewPw('');
            flash('Organizer password changed.');
          })}
          disabled={busy}
        >
          Change password
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ParentPortal({ game, wallets, log, flash, fail }) {
  const [pin, setPin] = useState('');
  const [wallet, setWallet] = useState(null);
  const [selected, setSelected] = useState({ firstGoal: null, firstPenalty: null, playmaker: null });
  const [busy, setBusy] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);
  const [bettor, setBettor] = useState('');
  const [otherName, setOtherName] = useState('');
  const [mode, setMode] = useState('virtual'); // 'virtual' (app draws) | 'physical' (real chip from the bag)

  // The organizer may have locked the game to one draw method. The
  // effective mode is the game's mode when locked, otherwise the parent's
  // own pick. Clear stale picks only when the organizer changes the
  // game's mode — a player number is not a card position and vice versa.
  // (The parent's own mode pick clears picks in pickMode; this effect
  // must NOT watch effectiveMode, or it would wipe a pick right after
  // the parent taps a player number.)
  const drawMode = game?.drawMode || 'mixed';
  const effectiveMode = drawMode === 'mixed' ? mode : drawMode;
  useEffect(() => {
    setSelected({ firstGoal: null, firstPenalty: null, playmaker: null });
  }, [drawMode]);

  const members = wallet ? familyMembers(wallet) : [];

  // Season odds per player/category for the pick buttons (ghost-win math —
  // see playerOdds). Runs on every render, even before login, so a bad log
  // shape would surface on the PIN screen rather than mid-draft.
  const odds = playerOdds(log);

  const pickBettor = (name) => {
    setBettor(name);
    setSelected({ firstGoal: null, firstPenalty: null, playmaker: null });
    setLastTicket(null);
  };

  // Switching draw method clears the picks — a virtual card position is not
  // a player number, and a physical player number is not a card position.
  const pickMode = (m) => {
    setMode(m);
    setSelected({ firstGoal: null, firstPenalty: null, playmaker: null });
  };

  const login = () => {
    const w = wallets.find((x) => x.codes && x.codes.includes(parseInt(pin, 10)));
    if (!w) return fail(new Error('No wallet found for that jersey number. Try again.'));
    setWallet(w);
    setLastTicket(null);
    setOtherName('');
    // A one-person family bets as that person automatically.
    const m = familyMembers(w);
    setBettor(m.length === 1 ? m[0] : '');
    flash(`Welcome, ${w.family}!`);
  };

  // Keep the wallet fresh from the live list.
  useEffect(() => {
    if (wallet) {
      const fresh = wallets.find((w) => w.familyId === wallet.familyId);
      if (fresh) setWallet(fresh);
    }
  }, [wallets]);

  const familyTickets = (game?.tickets || []).filter((t) => t.familyId === wallet?.familyId);
  const myTicket = familyTickets.find((t) => (t.bettor || t.buyer) === bettor);

  const buy = async (payLater = false) => {
    if (!bettor) return fail(new Error('Pick who is betting first.'));
    const picks = { ...selected };
    const count = CATEGORIES.filter((c) => picks[c.key] !== null).length;
    if (count === 0) {
      return fail(new Error(effectiveMode === 'physical'
        ? 'Tap a player in at least one category first.'
        : 'Tap one card in at least one category first.'));
    }
    setBusy(true);
    try {
      const { ticket } = (await api.buyTicket(wallet.familyId, bettor, picks, effectiveMode, payLater)).data;
      setLastTicket(ticket);
      setSelected({ firstGoal: null, firstPenalty: null, playmaker: null });
      flash(payLater
        ? `Play bought for ${bettor} — $${(ticket.paidCents / 100).toFixed(2)} on Play now pay later. Good luck!`
        : `Play bought for ${bettor} — $${(ticket.paidCents / 100).toFixed(2)}. Good luck!`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!wallet) {
    return (
      <div className="card">
        <h2>Parent Portal</h2>
        <p className="muted">Enter your kid’s jersey number to open your family wallet.</p>
        <input type="number" placeholder="Jersey # (e.g. 22)" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
        <button onClick={login}>Open my wallet</button>
      </div>
    );
  }

  if (!game || game.phase !== 'open') {
    return (
      <div className="card">
        <h2>{wallet.familyLabel}</h2>
        <p>Wallet balance: <strong>{money(wallet.balanceCents)}</strong></p>
        <p className="muted">
          {game?.phase === 'closed'
            ? 'The draft is closed — the game has started. Good luck!'
            : 'No game is open right now — check back before puck drop.'}
        </p>
        <button className="ghost" onClick={() => setWallet(null)}>Switch family</button>
      </div>
    );
  }

  const selectedCount = CATEGORIES.filter((c) => selected[c.key] !== null).length;
  const price = selectedCount * 2;

  return (
    <div className="card">
      <h2>{wallet.familyLabel}</h2>
      <p>Wallet balance: <strong>{money(wallet.balanceCents)}</strong></p>
      <p className="muted">
        {fmtDate(game.gameDate)} · Foxes vs {game.opponent || 'TBD'} · Goalie #{game.startingGoalie}
      </p>
      {(game.scratched || []).length > 0 && (
        <p className="muted small">Out today: {game.scratched.map((n) => `#${n} ${ROSTER.find((p) => p.number === n)?.name || ''}`).join(', ')}</p>
      )}

      <h3>Who&apos;s betting?</h3>
      <div className="row">
        {members.map((m) => (
          <button key={m} className={bettor === m ? 'primary' : ''} onClick={() => pickBettor(m)}>{fullName(m, wallet.familyId)}</button>
        ))}
      </div>
      <label>
        Someone else{' '}
        <input type="text" placeholder="Type their name" value={otherName} onChange={(e) => setOtherName(e.target.value)} />
        <button onClick={() => {
          const n = otherName.trim();
          if (!n) return fail(new Error('Type a name first'));
          pickBettor(n);
          setOtherName('');
        }}>Use this name</button>
      </label>
      {familyTickets.length > 0 && (
        <p className="muted small">
          Bets from this family: {familyTickets.map((t) => fullName(t.bettor || t.buyer, t.familyId)).join(', ')}
        </p>
      )}

      {!bettor ? (
        <p className="muted">Pick who&apos;s betting above to draft your picks.</p>
      ) : myTicket || lastTicket ? (
        <div>
          <h3>{bettor}&apos;s play</h3>
          <TicketCard ticket={myTicket || lastTicket} game={game} showPayouts={false} odds={odds} />
          <p className="muted small">One play per person per game — tap another name above to buy for someone else in the family.</p>
        </div>
      ) : (
        <div>
          <h3>Draft {bettor}&apos;s picks</h3>
          {drawMode === 'mixed' ? (
            <div className="row">
              <button className={mode === 'virtual' ? 'primary' : ''} onClick={() => pickMode('virtual')}>🎲 Virtual chips</button>
              <button className={mode === 'physical' ? 'primary' : ''} onClick={() => pickMode('physical')}>🪙 Real chips</button>
            </div>
          ) : (
            <p className="muted small">
              {drawMode === 'physical'
                ? 'The organizer set this game to real chips — draw from the bag, then tap the player you got.'
                : 'The organizer set this game to the virtual draw — tap the face-down cards below.'}
            </p>
          )}
          {effectiveMode === 'virtual' ? (
            <p className="muted small">Tap one face-down card per category — $2 per category ($1 to the pot, $1 to the slush). The cards are shuffled — you won’t know who you drew until you buy.</p>
          ) : (
            <p className="muted small">Draw a real chip from the bag for each category, then tap the player you got below — $2 per category ($1 to the pot, $1 to the slush). Players already drawn are gone from the bag. The % under each player is how often they&apos;ve won that category this season — nobody&apos;s at 0%, every kid has a shot.</p>
          )}
          {CATEGORIES.map(({ key, label }) => {
            const count = game.deckCounts?.[key] ?? 0;
            if (effectiveMode === 'physical') {
              const taken = new Set((game.tickets || []).map((t) => t.picks?.[key]?.number).filter((n) => n != null));
              // Who can be picked: the goalie in net is out of First Goal
              // only, and Harrison is out of everything when he is the backup.
              const available = ROSTER.filter((p) => !taken.has(p.number) && inDraw(p.number, key, game.startingGoalie, game.scratched));
              return (
                <div key={key} className="draft-cat">
                  <strong>{label}</strong> — pot {money(game.pots?.[key] || 0)} · {available.length} chips left
                  <div className="deck">
                    {available.map((p) => {
                      const w = odds.wins[key].get(p.number) || 0;
                      return (
                        <button
                          key={p.number}
                          className={selected[key] === p.number ? 'picked' : ''}
                          onClick={() => setSelected({ ...selected, [key]: selected[key] === p.number ? null : p.number })}
                        >
                          #{p.number} {p.name}
                          <span className="odds-line">{oddsPct(w, odds.games)}% · {w} win{w === 1 ? '' : 's'}</span>
                        </button>
                      );
                    })}
                    {available.length === 0 && (
                      <span className="muted small"> No chips left in the bag for this one — switch to virtual or skip it.</span>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={key} className="draft-cat">
                <strong>{label}</strong> — pot {money(game.pots?.[key] || 0)} · {count} cards left
                <div className="deck">
                  {Array.from({ length: count }, (_, i) => (
                    <button
                      key={i}
                      className={`card-back ${selected[key] === i ? 'picked' : ''}`}
                      onClick={() => setSelected({ ...selected, [key]: selected[key] === i ? null : i })}
                    >
                      ?
                    </button>
                  ))}
                  {count === 0 && (
                    <span>
                      <button
                        className={`card-back ${selected[key] === -1 ? 'picked' : ''}`}
                        onClick={() => setSelected({ ...selected, [key]: selected[key] === -1 ? null : -1 })}
                      >?</button>
                      <span className="muted small"> Deck is out — draws any player.</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <p>
            <button className="primary" onClick={() => buy(false)} disabled={busy || selectedCount === 0}>
              Buy play for {bettor} — ${price}.00
            </button>
          </p>
          {wallet.balanceCents < price * 100 && (
            <p>
              <button className="ghost" onClick={() => buy(true)} disabled={busy || selectedCount === 0}>
                Play now pay later — ${price}.00
              </button>
              <span className="muted small"> Your wallet is short — this play goes through and the balance goes negative until you pay the organizer.</span>
            </p>
          )}
        </div>
      )}
      <button className="ghost" onClick={() => { setWallet(null); setBettor(''); setOtherName(''); }}>Switch family</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function picksByCategory(game, key) {
  // Group every play's pick for one category by player number, so the
  // Board reads "who picked which player" instead of one card per person.
  const byNumber = new Map();
  (game.tickets || []).forEach((t) => {
    const pick = t.picks?.[key];
    if (!pick) return;
    const bettor = t.bettor || t.buyer;
    if (!byNumber.has(pick.number)) {
      byNumber.set(pick.number, { number: pick.number, name: pick.name, bettors: [] });
    }
    byNumber.get(pick.number).bettors.push(fullName(bettor, t.familyId));
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function Board({ game, flash, fail }) {
  if (!game) return <div className="card"><p>Loading…</p></div>;
  const isOpen = game.phase === 'open' || game.phase === 'closed';
  return (
    <div>
      <div className="card">
        <h2>{isOpen ? `Picks for Foxes vs ${game.opponent || 'TBD'}` : 'Picks & winners'}</h2>
        {/* Game banner: always unambiguous which game this board is showing,
            so last game's winners can never be mistaken for this game's. */}
        {isOpen ? (
          <p className="game-banner">
            📅 {fmtDate(game.gameDate)} · <strong>Foxes vs {game.opponent || 'TBD'}</strong> · Goalie #{game.startingGoalie}
            {game.phase === 'closed' ? ' · Draft closed — game in progress' : ''}
          </p>
        ) : (
          <p className="game-banner setup">
            No game in progress — the last game&apos;s winners are in the Game Log, not here.
          </p>
        )}
        <div className="pots">
          {CATEGORIES.map(({ key, label }) => {
            const res = game.resolutions?.[key];
            return (
              <div key={key} className="pot">
                <strong>{label}</strong>: {money(game.pots?.[key] || 0)}
                {!isOpen && (game.carryover?.[key] || 0) > 0 ? (
                  <span> (rolled over — starting pot for the next game)</span>
                ) : null}
                {isOpen && res && (
                  <span>
                    {' '}→ #{res.playerNumber} {res.playerName}{' '}
                    {res.winners.length === 0 ? <span className="badge rolled">Rollover</span> : null}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h3>Picks by category ({(game.tickets || []).length} {(game.tickets || []).length === 1 ? 'play' : 'plays'})</h3>
        {isOpen ? (
          (game.tickets || []).length === 0 ? (
            <p className="muted">No plays yet.</p>
          ) : (
            CATEGORIES.map(({ key, label }) => {
              const res = game.resolutions?.[key];
              const picks = picksByCategory(game, key);
              return (
                <div key={key} className="category-picks">
                  <h4>
                    {label} — {money(game.pots?.[key] || 0)}
                    {res && (
                      res.winners.length === 0
                        ? <span className="badge rolled"> Rollover</span>
                        : <span> · Winner: #{res.playerNumber} {res.playerName}</span>
                    )}
                  </h4>
                  {picks.length === 0 ? (
                    <p className="muted">No picks yet.</p>
                  ) : (
                    picks.map((p) => {
                      const isWinner = res && res.playerNumber === p.number;
                      return (
                        <div key={p.number} className={`pick-row ${isWinner ? 'winner' : ''}`}>
                          <span>#{p.number} {p.name}</span>
                          <span>{p.bettors.join(', ')}</span>
                          {isWinner && <span className="win-star"> ★ Winner</span>}
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })
          )
        ) : (
          <p className="muted">No plays — no game in progress. Winners from the last game are in the Game Log.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GameLogPage({ log }) {
  const [openId, setOpenId] = useState(null);
  return (
    <div className="card">
      <h2>Game Log</h2>
      <p className="muted small">Permanent record — resets can’t touch it. Newest first.</p>
      {log.length === 0 && <p className="muted">No games logged yet.</p>}
      {log.map((entry) => {
        const open = openId === entry.id;
        return (
          <div key={entry.id} className="log-entry">
            <button className="log-head" onClick={() => setOpenId(open ? null : entry.id)}>
              <strong>Foxes vs {entry.opponent || 'TBD'}</strong> · {fmtDate(entry.gameDate)}
              {entry.startingGoalie ? <> · Goalie #{entry.startingGoalie}</> : ''}
              {entry.drawMode === 'physical' ? ' · 🪙 Real chips' : entry.drawMode === 'virtual' ? ' · 🎲 Virtual draw' : ''}
              {entrySlush(entry) === null ? ' · Slush not recorded' : <> · Slush {money(entrySlush(entry))}</>}
              <span>{open ? ' ▲' : ' ▼'}</span>
            </button>
            {open && (
              <div className="log-body">
                <div className="pots">
                  {CATEGORIES.map(({ key, label }) => (
                    <div key={key} className="pot">
                      <strong>{label}</strong>: pot {money(entry.pots?.[key] || 0)}
                      {entry.rollovers?.[key] ? ` · rolled over ${money(entry.rollovers[key])}` : ''}
                      {entry.resolutions?.[key] && (
                        <span>
                          {' '}→ #{entry.resolutions[key].playerNumber} {entry.resolutions[key].playerName}
                          {entry.resolutions[key].winners.length === 0 ? ' (nobody picked)' : ''}
                        </span>
                      )}
                      {!entry.resolutions?.[key] && <span> (undecided)</span>}
                    </div>
                  ))}
                </div>
                <h4>Plays ({entry.tickets?.length || 0})</h4>
                {(entry.tickets || []).map((t) => (
                  <div key={t.id} className="ticket">
                    <div className="ticket-head">
                      <strong>{fullName(t.bettor || t.buyer, t.familyId)}</strong>
                      <span className="muted">{t.familyLabel}</span>
                      <span className="price">{money(t.paidCents)}</span>
                    </div>
                    <div className="picks">
                      {CATEGORIES.map(({ key, label }) => {
                        const pick = t.picks?.[key];
                        const res = entry.resolutions?.[key];
                        const isWinner = res && pick && res.playerNumber === pick.number;
                        const w = res?.winners.find((x) => x.ticketId === t.id);
                        return (
                          <div key={key} className={`pick ${isWinner ? 'winner' : ''}`}>
                            <span className="muted">{label}:</span>{' '}
                            {pick ? `#${pick.number} ${pick.name}` : '—'}
                            {isWinner && (
                              <span>
                                {' '}★ won {money(w.payoutCents)} <PayoutBadge disposition={w.disposition} />
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

// Season standings: totals across every game in the Game Log plus the
// game in progress (if one is open). All of it is added up here in the
// browser from the same game / log / wallet data the rest of the app
// already loads — nothing extra is stored.
function SeasonPage({ game, log, wallets }) {
  const inProgress = game && (game.phase === 'open' || game.phase === 'closed');
  const sources = [];
  if (inProgress) sources.push({ tickets: game.tickets || [], resolutions: game.resolutions || {} });
  for (const entry of log || []) {
    sources.push({ tickets: entry.tickets || [], resolutions: entry.resolutions || {} });
  }
  const gamesCount = sources.length;

  const fam = new Map(); // familyId -> totals
  const people = new Map(); // familyId|buyer -> totals
  const ensureFam = (familyId, familyLabel) => {
    const key = String(familyId);
    if (!fam.has(key)) {
      fam.set(key, { familyId: key, familyLabel: familyLabel || '', plays: 0, spentCents: 0, wonCents: 0, wins: 0 });
    }
    const f = fam.get(key);
    if (familyLabel && !f.familyLabel) f.familyLabel = familyLabel;
    return f;
  };
  const ensurePerson = (familyId, buyer, familyLabel) => {
    const key = `${familyId}|${buyer}`;
    if (!people.has(key)) {
      people.set(key, { key, familyId: String(familyId), buyer, familyLabel: familyLabel || '', plays: 0, spentCents: 0, wonCents: 0, wins: 0 });
    }
    return people.get(key);
  };

  for (const src of sources) {
    const byTicket = new Map((src.tickets || []).map((t) => [t.id, t]));
    for (const t of src.tickets || []) {
      const f = ensureFam(t.familyId, t.familyLabel || t.family);
      f.plays += 1;
      f.spentCents += t.paidCents || 0;
      const p = ensurePerson(t.familyId, t.bettor || t.buyer, t.familyLabel || t.family);
      p.plays += 1;
      p.spentCents += t.paidCents || 0;
    }
    for (const { key } of CATEGORIES) {
      const res = src.resolutions ? src.resolutions[key] : null;
      if (!res) continue;
      for (const w of res.winners || []) {
        const t = byTicket.get(w.ticketId);
        const f = ensureFam(w.familyId, t?.familyLabel || w.family);
        f.wonCents += w.payoutCents || 0;
        f.wins += 1;
        const p = ensurePerson(w.familyId, w.buyer, t?.familyLabel || w.family);
        p.wonCents += w.payoutCents || 0;
        p.wins += 1;
      }
    }
  }

  const topPeople = [...people.values()]
    .filter((p) => p.wins > 0)
    .sort((a, b) => b.wonCents - a.wonCents || b.wins - a.wins || a.buyer.localeCompare(b.buyer));

  // Which PLAYERS won each category (the kid who scored / took the penalty /
  // made the play), counted across every logged game — including games where
  // the pot rolled because nobody picked them. For the parents to see.
  const playerWins = {};
  for (const { key } of CATEGORIES) {
    const byPlayer = new Map();
    for (const src of sources) {
      const res = src.resolutions ? src.resolutions[key] : null;
      if (!res || !res.playerNumber) continue;
      const cur = byPlayer.get(res.playerNumber) || { number: res.playerNumber, name: res.playerName || '', wins: 0 };
      cur.wins += 1;
      if (res.playerName && !cur.name) cur.name = res.playerName;
      byPlayer.set(res.playerNumber, cur);
    }
    playerWins[key] = [...byPlayer.values()].sort((a, b) => b.wins - a.wins || a.number - b.number);
  }
  return (
    <div className="card">
      <h2>🏆 Season standings</h2>
      <p className="muted small">
        {gamesCount === 0
          ? 'No games yet — standings appear after the first game.'
          : `Added up from ${gamesCount} game${gamesCount === 1 ? '' : 's'}${inProgress ? ', including the game in progress' : ''}.`}
      </p>

      <div className="standings-panel">
        <h3>Top winners — by person</h3>
        {topPeople.length === 0 ? (
          <p className="muted">No winners yet.</p>
        ) : (
          topPeople.map((p, i) => (
            <div key={p.key} className="pick-row">
              <span>{i + 1}. <strong>{fullName(p.buyer, p.familyId)}</strong> <span className="muted">({p.familyLabel})</span></span>
              <span>{p.wins} win{p.wins === 1 ? '' : 's'} · <strong>{money(p.wonCents)}</strong></span>
            </div>
          ))
        )}
      </div>

      <div className="standings-panel gold">
        <h3>Winning players — by category</h3>
        {CATEGORIES.map(({ key, label }) => (
          <div key={key}>
            <p><strong>{label}</strong></p>
            {playerWins[key].length === 0 ? (
              <p className="muted">No winner yet.</p>
            ) : (
              playerWins[key].map((r) => {
                const crowned = r.wins === playerWins[key][0].wins;
                return (
                  <div key={r.number} className={crowned ? 'pick-row crowned' : 'pick-row'}>
                    <span>{crowned ? '👑 ' : ''}#{r.number} {r.name}</span>
                    <span>{r.wins} win{r.wins === 1 ? '' : 's'}</span>
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
