// PKCE (RFC 7636) for Spotify's Authorization Code flow.
//
// Split out from spotify.ts because this is pure, dependency-free, and
// directly unit-testable against RFC 7636's own published test vector -- which
// is worth doing rather than trusting a hand-rolled hash-and-encode. A bug
// here would not be loud: a malformed challenge fails at Spotify's authorize
// endpoint with an opaque message, and a verifier/challenge mismatch fails
// only at the token exchange, after the user has already granted consent.
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 sec4.1 allows 43-128 characters from [A-Za-z0-9-._~]. 64 bytes of
 * randomness base64url-encodes to 86 characters -- comfortably inside the
 * range, and base64url's alphabet is a subset of the permitted one, so the
 * result needs no further filtering. (32 bytes would also be conformant at 43
 * characters; 64 is chosen for margin, since the cost is nil.) */
const VERIFIER_BYTES = 64;

/** Minimum/maximum verifier length, enforced on the way back IN (from a
 * cookie) as well as on the way out. A truncated or padded cookie value is
 * something to reject before it reaches Spotify, not after. */
export const VERIFIER_MIN_LENGTH = 43;
export const VERIFIER_MAX_LENGTH = 128;

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

export function createCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString("base64url");
}

/**
 * base64url(SHA256(verifier)), which is what `code_challenge` must be when
 * `code_challenge_method=S256`.
 *
 * Note it hashes the verifier's ASCII *characters*, not the bytes that were
 * base64url-encoded to produce it -- a genuinely easy mistake to make when the
 * verifier happens to be base64url itself, and one that produces a
 * plausible-looking challenge that fails only at code exchange.
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Validates a verifier read back out of a cookie before it is spent at the
 * token endpoint. Cheap, and it turns a tampered or truncated cookie into a
 * clean "start again" outcome rather than an opaque Spotify rejection. */
export function isValidCodeVerifier(value: string | undefined): value is string {
  if (!value) return false;
  if (value.length < VERIFIER_MIN_LENGTH || value.length > VERIFIER_MAX_LENGTH) return false;
  return VERIFIER_PATTERN.test(value);
}
