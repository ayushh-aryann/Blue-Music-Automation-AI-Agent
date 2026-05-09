const crypto = require("crypto");

// Apple Music — without the user's developer credentials we can't sign a
// developer JWT, and without a subscriber-side login we can't trigger
// playback. We return setup guidance instead of failing silently.
async function appleProviderPlay() {
  if (!process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || !process.env.APPLE_PRIVATE_KEY) {
    return {
      ok: false,
      error: "Apple Music needs APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY in .env. See README.",
      setupRequired: true,
    };
  }
  // The frontend handles MusicKit play directly once it has the developer
  // token — server-side we just confirm credentials are wired. The frontend
  // will call /api/apple/developer-token then MusicKit.authorize().
  return {
    ok: false,
    apple: { ready: true, needsClientAuth: true },
    error: "Apple Music ready — sign in via the player to start playback.",
  };
}

function mintAppleDeveloperToken() {
  const teamId  = process.env.APPLE_TEAM_ID;
  const keyId   = process.env.APPLE_KEY_ID;
  const privKey = (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!teamId || !keyId || !privKey) {
    const err = new Error("Apple Music creds missing. Set APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY in .env.");
    err.setupRequired = true;
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 12; // 12h
  const header  = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: teamId, iat: now, exp };
  const token = signES256JWT(header, payload, privKey);
  return { token, expiresAt: exp };
}

function signES256JWT(header, payload, privateKeyPem) {
  const b64url = (buf) => Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headerB64  = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign("SHA256");
  signer.update(data);
  signer.end();
  // Apple expects a JOSE-format ES256 signature (r||s, 64 bytes), but
  // crypto.createSign returns DER. Use dsaEncoding:"ieee-p1363" to get JOSE.
  const sig = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}

module.exports = { appleProviderPlay, mintAppleDeveloperToken, signES256JWT };
