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

const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—';

function errMsg(err) {
  return (err && err.message) || 'Something went wrong';
}

function PayoutBadge({ disposition }) {
  if (disposition === 'paid') return <span className="badge paid">Paid</span>;
  if (disposition === 'rolled') return <span className="badge rolled">Rolled to account</span>;
  return <span className="badge unmarked">Not paid yet</span>;
}

function TicketCard({ ticket, game, showPayouts, onPayout }) {
  const winnersFor = (cat) => {
    const res = game?.resolutions?.[cat];
    if (!res) return null;
    return res.winners.find((w) => w.ticketId === ticket.id) || null;
  };
  return (
    <div className="ticket">
      <div className="ticket-head">
        <strong>{ticket.buyer}</strong>
        <span className="muted">{ticket.familyLabel}</span>
        <span className="price">{money(ticket.paidCents)}</span>
      </div>
      <div className="picks">
        {CATEGORIES.map(({ key, label }) => {
          const pick = ticket.picks?.[key];
          const res = game?.resolutions?.[key];
          const isWinner = res && pick && res.playerNumber === pick.number;
          return (
            <div key={key} className={`pick ${isWinner ? 'winner' : ''}`}>
              <span className="muted">{label}:</span>{' '}
              {pick ? `#${pick.number} ${pick.name}` : '—'}
              {isWinner && <span className="win-star"> ★ Winner</span>}
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
                  {label}: won {money(w.payoutCents)} <PayoutBadge disposition={w.disposition} />
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
        <h1>🏒 Foxes Slush Fund Draft</h1>
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
      {view === 'organizer' && <OrganizerPage game={game} wallets={walletList} flash={flash} fail={fail} />}
      {view === 'parent' && <ParentPortal game={game} wallets={walletList} flash={flash} fail={fail} />}
      {view === 'board' && <Board game={game} flash={flash} fail={fail} />}
      {view === 'gamelog' && <GameLogPage log={log} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Landing({ game, onGo, onInit }) {
  return (
    <div className="card">
      <h2>Welcome</h2>
      {game ? (
        <p>
          {game.phase === 'open' ? (
            <>
              📅 {fmtDate(game.gameDate)} · Foxes vs {game.opponent || 'TBD'} ·{' '}
              <strong>{game.tickets?.length || 0} tickets sold</strong> · Slush (season):{' '}
              <strong>{money(game.slushCents)}</strong>
            </>
          ) : (
            <>No game open yet — the draft hasn&apos;t started. Slush (season): <strong>{money(game.slushCents)}</strong></>
          )}
        </p>
      ) : (
        <p className="muted">
          The app hasn&apos;t been set up yet. The organizer signs in once and taps “Seed the app” below.
        </p>
      )}
      <div className="menu">
        <button onClick={() => onGo('organizer')}>Organizer Page</button>
        <button onClick={() => onGo('parent')}>Parent Portal</button>
        <button onClick={() => onGo('board')}>All Picks &amp; Winners</button>
        <button onClick={() => onGo('gamelog')}>Game Log</button>
      </div>
      {!game && (
        <p>
          <button className="ghost" onClick={onInit}>Seed the app (organizer)</button>
        </p>
      )}
      <p className="muted small">
        Parents log in with their kid&apos;s jersey number. The organizer logs in with the
        organizer password. Winnings are paid out by the organizer — or rolled into the
        family&apos;s account as credit for future tickets.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OrganizerPage({ game, wallets, flash, fail }) {
  const [pw, setPw] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Start a New Game form
  const [gameDate, setGameDate] = useState(todayStr());
  const [opponent, setOpponent] = useState('');
  const [goalie, setGoalie] = useState(88);
  const [potInputs, setPotInputs] = useState({ firstGoal: '', firstPenalty: '', playmaker: '' });

  // Bank manager
  const [depFamily, setDepFamily] = useState('');
  const [depAmount, setDepAmount] = useState('');

  // Resolve
  const [resolvePick, setResolvePick] = useState({ firstGoal: '', firstPenalty: '', playmaker: '' });

  // Change password
  const [newPw, setNewPw] = useState('');

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
    }
  }, [game?.gameId]);

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

  const deposit = async () => {
    const dollars = parseFloat(depAmount);
    if (!depFamily || Number.isNaN(dollars) || dollars <= 0) return fail(new Error('Pick a family and enter an amount over $0'));
    await run(async () => {
      await api.deposit(depFamily, Math.round(dollars * 100));
      flash(`Deposited $${dollars.toFixed(2)}.`);
      setDepAmount('');
    });
  };

  const resolve = async (key) => {
    const num = parseInt(resolvePick[key], 10);
    if (!num) return fail(new Error('Pick a player first'));
    await run(async () => {
      const { resolution } = (await api.resolveCategory(key, num)).data;
      if (resolution.winners.length === 0) {
        flash(`${CATEGORIES.find((c) => c.key === key).label}: nobody picked #${num} — the ${money(resolution.potCents)} pot rolls over.`);
      } else {
        flash(`${CATEGORIES.find((c) => c.key === key).label} resolved — ${resolution.winners.length} winner(s), ${money(resolution.potCents)} pot.`);
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
    if (!window.confirm('FACTORY RESET — this wipes EVERYTHING: tickets, pots, carryovers, slush, all wallets to $0, and the whole Game Log. The organizer password stays the same. Are you sure?')) return;
    if (!window.confirm('Really sure? There is no undo.')) return;
    await run(async () => {
      await api.factoryReset();
      flash('App wiped back to a clean slate.');
    });
  };

  return (
    <div>
      <div className="card">
        <h2>Organizer</h2>
        <p className="muted">
          {game.phase === 'open'
            ? `Game open: ${fmtDate(game.gameDate)} · Foxes vs ${game.opponent || 'TBD'} · Goalie #${game.startingGoalie}`
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

          <h3>Step 3 — Starting pots</h3>
          <p className="muted small">Rolled-over pots fill in automatically. Edit them here if the real amount is different.</p>
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
        </div>
      )}

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
            <div key={w.familyId} className="wallet-chip">{w.familyLabel}: <strong>{money(w.balanceCents)}</strong></div>
          ))}
        </div>
      </div>

      {game.phase === 'open' && (
        <div className="card">
          <h2>Resolve the game</h2>
          {CATEGORIES.map(({ key, label }) => {
            const res = game.resolutions?.[key];
            return (
              <div key={key} className="resolve-row">
                <strong>{label}</strong> — pot {money(game.pots?.[key] || 0)}
                {res ? (
                  <span>
                    {' '}→ #{res.playerNumber} {res.playerName} ·{' '}
                    {res.winners.length === 0 ? (
                      <span className="badge rolled">Nobody picked — rollover</span>
                    ) : (
                      <span>{res.winners.length} winner(s), {money(res.potCents)} pot</span>
                    )}
                  </span>
                ) : (
                  <span className="row">
                    <select value={resolvePick[key]} onChange={(e) => setResolvePick({ ...resolvePick, [key]: e.target.value })}>
                      <option value="">Who scored / took it? …</option>
                      {ROSTER.map((p) => (
                        <option key={p.number} value={p.number}>#{p.number} {p.name}</option>
                      ))}
                    </select>
                    <button onClick={() => resolve(key)} disabled={busy}>Resolve {label}</button>
                  </span>
                )}
              </div>
            );
          })}

          <h3>Winners &amp; payouts</h3>
          {(game.tickets || []).map((t) => (
            <TicketCard key={t.id} ticket={t} game={game} showPayouts onPayout={payout} />
          ))}
          {(game.tickets || []).length === 0 && <p className="muted">No tickets sold yet.</p>}

          <h3>End the game</h3>
          {unmarkedWinners.length > 0 && (
            <p className="warn">⚠️ {unmarkedWinners.length} winner(s) still “Not paid yet”. Mark them paid or rolled before resetting, or they’ll be logged as unpaid.</p>
          )}
          <button className="primary" onClick={reset} disabled={busy}>Reset Game — save to log &amp; start fresh</button>
        </div>
      )}

      <div className="card danger-zone">
        <h2>Factory reset</h2>
        <p className="muted small">Wipes tickets, pots, carryovers, slush, all wallets to $0, and the whole Game Log. The organizer password stays the same.</p>
        <button className="danger" onClick={factoryReset} disabled={busy}>Factory reset — wipe everything</button>
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

function ParentPortal({ game, wallets, flash, fail }) {
  const [pin, setPin] = useState('');
  const [wallet, setWallet] = useState(null);
  const [selected, setSelected] = useState({ firstGoal: null, firstPenalty: null, playmaker: null });
  const [busy, setBusy] = useState(false);
  const [lastTicket, setLastTicket] = useState(null);

  const login = () => {
    const w = wallets.find((x) => x.codes && x.codes.includes(parseInt(pin, 10)));
    if (!w) return fail(new Error('No wallet found for that jersey number. Try again.'));
    setWallet(w);
    setLastTicket(null);
    flash(`Welcome, ${w.family}!`);
  };

  // Keep the wallet fresh from the live list.
  useEffect(() => {
    if (wallet) {
      const fresh = wallets.find((w) => w.familyId === wallet.familyId);
      if (fresh) setWallet(fresh);
    }
  }, [wallets]);

  const myTicket = game?.tickets?.find((t) => t.familyId === wallet?.familyId);

  const buy = async () => {
    const picks = { ...selected };
    const count = CATEGORIES.filter((c) => picks[c.key] !== null).length;
    if (count === 0) return fail(new Error('Tap one card in at least one category first.'));
    setBusy(true);
    try {
      const { ticket } = (await api.buyTicket(wallet.familyId, wallet.family, picks)).data;
      setLastTicket(ticket);
      setSelected({ firstGoal: null, firstPenalty: null, playmaker: null });
      flash(`Ticket bought — $${(ticket.paidCents / 100).toFixed(2)}. Good luck!`);
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
        <p className="muted">No game is open right now — check back before puck drop.</p>
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

      {myTicket || lastTicket ? (
        <div>
          <h3>Your ticket</h3>
          <TicketCard ticket={myTicket || lastTicket} game={game} showPayouts={false} />
          <p className="muted small">One ticket per family per game.</p>
        </div>
      ) : (
        <div>
          <h3>Draft your picks — tap one face-down card per category</h3>
          <p className="muted small">$2 per category ($1 to the pot, $1 to the slush). The cards are shuffled — you won’t know who you drew until you buy.</p>
          {CATEGORIES.map(({ key, label }) => {
            const count = game.deckCounts?.[key] ?? 0;
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
                  {count === 0 && <span className="muted">All cards drawn.</span>}
                </div>
              </div>
            );
          })}
          <p>
            <button className="primary" onClick={buy} disabled={busy || selectedCount === 0}>
              Buy ticket — ${price}.00
            </button>
          </p>
          {wallet.balanceCents < price * 100 && (
            <p className="warn">Your wallet doesn’t cover ${price}.00 — ask the organizer to top it up.</p>
          )}
        </div>
      )}
      <button className="ghost" onClick={() => setWallet(null)}>Switch family</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Board({ game, flash, fail }) {
  if (!game) return <div className="card"><p>Loading…</p></div>;
  const isOpen = game.phase === 'open';
  return (
    <div>
      <div className="card">
        <h2>All Picks &amp; Winners</h2>
        {/* Game banner: always unambiguous which game this board is showing,
            so last game's winners can never be mistaken for this game's. */}
        {isOpen ? (
          <p className="game-banner">
            📅 {fmtDate(game.gameDate)} · <strong>Foxes vs {game.opponent || 'TBD'}</strong> · Goalie #{game.startingGoalie}
          </p>
        ) : (
          <p className="game-banner setup">
            No game in progress — the last game&apos;s winners are in the Game Log, not here.
          </p>
        )}
        <p className="muted">
          Season slush owed to Amanda: <strong>{money(game.slushCents)}</strong>
        </p>
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
        <h3>Tickets ({(game.tickets || []).length})</h3>
        {isOpen ? (
          (game.tickets || []).length === 0 ? (
            <p className="muted">No tickets sold yet.</p>
          ) : (
            (game.tickets || []).map((t) => (
              <TicketCard key={t.id} ticket={t} game={game} showPayouts />
            ))
          )
        ) : (
          <p className="muted">No tickets — no game in progress. Winners from the last game are in the Game Log.</p>
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
              <strong>Foxes vs {entry.opponent || 'TBD'}</strong> · {fmtDate(entry.gameDate)} ·{' '}
              Goalie #{entry.startingGoalie} · Slush {money(entry.slushGameCents)} (season {money(entry.slushSeasonCents)})
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
                <h4>Tickets ({entry.tickets?.length || 0})</h4>
                {(entry.tickets || []).map((t) => (
                  <div key={t.id} className="ticket">
                    <div className="ticket-head">
                      <strong>{t.buyer}</strong>
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
