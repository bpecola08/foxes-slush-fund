// HTTP wrapper for the Vercel serverless API functions.
//
// Each api/*.js file exports `module.exports = handler(async (body) => {...})`.
// The wrapper:
//   - accepts POST only (anything else is a 405),
//   - parses the JSON body (Vercel populates req.body for JSON; the stream
//     fallback covers local node http and tests),
//   - returns `{ ok: true, ...result }` on success,
//   - returns `{ ok: false, error, code }` with the right HTTP status on
//     failure (401 bad organizer password, 400 bad input / logic errors).
//
// The frontend (hosting/src/api.js) calls these with fetch and unwraps the
// same shapes the old Firebase callables returned, so the React app is
// unchanged apart from the transport.

const { ApiError, toApiError } = require('./db');

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      if (req.body.trim() === '') return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw new ApiError(400, 'invalid_argument', 'Request body must be valid JSON');
      }
    }
    if (typeof req.body === 'object' && req.body !== null) return req.body;
  }
  // Stream fallback (local node http server / tests without a parsed body).
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_argument', 'Request body must be valid JSON');
  }
}

function handler(fn) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'POST');
        return res.status(405).json({
          ok: false,
          error: 'Method not allowed — use POST',
          code: 'method_not_allowed',
        });
      }
      const body = await readJsonBody(req);
      const out = await fn(body);
      return res.status(200).json({ ok: true, ...(out || {}) });
    } catch (err) {
      const apiErr = toApiError(err);
      // Never leak stack traces or internals to the client.
      return res.status(apiErr.status).json({
        ok: false,
        error: apiErr.message,
        code: apiErr.code,
      });
    }
  };
}

module.exports = { handler, readJsonBody };
