// Organizer password hashing — server-side only.
// Uses Node's built-in scrypt (no extra dependencies). The hash is stored as
// "saltHex:hashHex" in the Firestore document `private/organizer` (client
// access to `private/*` is denied by firestore.rules). The plaintext password
// NEVER appears in the repo, in client code, or in Firestore.
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };

function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    });
    return (
      actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, SCRYPT_PARAMS };
