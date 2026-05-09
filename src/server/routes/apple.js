const { json } = require("../lib/http");
const { mintAppleDeveloperToken } = require("../providers/apple");

// ════════════════════════════════════════════════════════════════════════════
// APPLE MUSIC DEVELOPER TOKEN
// MusicKit JS needs a developer token (signed JWT) before it can authorize a
// user. We mint that JWT here using ES256 (Apple's required algorithm). Real
// playback still requires a subscriber JWT, which MusicKit obtains client-side
// after the user signs in with their Apple ID.
// ════════════════════════════════════════════════════════════════════════════
async function appleDeveloperTokenEndpoint(res) {
  try {
    const { token, expiresAt } = mintAppleDeveloperToken();
    json(res, { ok: true, token, expiresAt });
  } catch (error) {
    if (error.setupRequired) {
      return json(res, { ok: false, error: error.message, setupRequired: true }, 501);
    }
    json(res, { ok: false, error: error.message }, 500);
  }
}

module.exports = { appleDeveloperTokenEndpoint };
