// POST /api/organizer — { password, action, ... }.
// Organizer password actions.
// action: 'login' | 'changePassword'.
//   login:          { password } -> {} when it matches. The client keeps the
//                   password in memory only (never in Firestore/storage).
//   changePassword: { password, newPassword } -> {}. Old password required;
//                   the new password is stored only as a scrypt hash.
const { handler } = require('./_lib/http');
const db = require('./_lib/db');
const { hashPassword } = require('../lib/auth');

module.exports = handler(async (body) => {
  await db.requireOrganizer(body);
  const action = body && body.action;
  if (action === 'login') {
    return {};
  }
  if (action === 'changePassword') {
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
  }
  throw new Error(`Unknown organizer action: ${action}`);
});
