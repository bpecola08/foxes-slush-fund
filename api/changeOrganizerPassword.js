// POST /api/changeOrganizerPassword — { password, newPassword } -> { ok: true }.
// Old password required; the new password is stored only as a scrypt hash.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const { hashPassword } = require('../lib/auth');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const { newPassword } = body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    const { ApiError } = require('./_lib/db');
    throw new ApiError(400, 'invalid_argument', 'New password must be at least 4 characters');
  }
  const hash = hashPassword(newPassword);
  const firestore = db.db();
  await firestore.doc(db.ORGANIZER_DOC).set({
    passwordHash: hash,
    updatedAt: db.serverTimestamp(),
  });
  return {};
});
