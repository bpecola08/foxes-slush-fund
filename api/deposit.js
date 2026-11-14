// POST /api/deposit — { password, familyId, amountCents } -> { balanceCents }.
// Parent: add money to a family wallet. (Organizer-run in practice: the
// organizer takes cash/Venmo and tops the wallet up.)
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const balance = await db.withState((state) => {
    const b = logic.deposit(state, body.familyId, body.amountCents);
    return { result: b };
  });
  return { balanceCents: balance };
});
