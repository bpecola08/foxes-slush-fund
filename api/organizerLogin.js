// POST /api/organizerLogin — { password } -> { ok: true } when it matches.
// The client keeps the password in memory only (never in Firestore/storage).
const { handler } = require('./_lib/http');
const db = require('./_lib/db');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  return {};
});
