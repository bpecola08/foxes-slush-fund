// POST /api/payAmanda — { password } -> { paidCents, paidAt }.
// Password-gated: records that the season slush total was sent to Amanda
// Beckett and resets the amount owed to $0. The payment is kept in
// slushPayments so the organizer can see what was paid and when.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const logic = require('../lib/logic');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  return db.withState((state) => logic.payAmanda(state));
});
