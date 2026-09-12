// Refresh-token encryption for calendar_connections (migrations/0020).
//
// THE IMPLEMENTATION MOVED, 2026-09-13, to lib/crypto/token-envelope.ts, when
// Spotify (migrations/0024) became the second consumer of the exact same
// AES-256-GCM envelope. Nothing about the format, the key handling, or the
// error wording changed -- this file is now the calendar-labelled face of that
// shared module, which is what keeps every existing call site and
// crypto.test.ts's assertions (including the exact error strings) valid.
//
// Why a wrapper survives at all rather than callers importing the shared
// module directly: the error text a user or operator eventually sees has to
// name the thing they must reconnect. "Stored token could not be decrypted"
// is not an actionable message; "Reconnect the calendar" is. The labels below
// are the entire content of this file.
//
// The format itself, and why encryption happens here rather than in the
// database (pgcrypto is deliberately not installed; decisions.md 2026-09-11),
// is documented in lib/crypto/token-envelope.ts.
import { decryptToken, encryptToken, type EnvelopeLabels } from "@/lib/crypto/token-envelope";

export { generateEncryptionKey, parseEncryptionKey } from "@/lib/crypto/token-envelope";

/** Deliberately the shared error class under a calendar-shaped name, not a
 * subclass: every caller's correct response is the same ("ask the user to
 * reconnect"), so a distinct type would be a distinction no handler acts on.
 * Kept as a named export because that is what this module's callers and tests
 * already catch on. */
export { TokenEnvelopeError as CalendarCryptoError } from "@/lib/crypto/token-envelope";

const LABELS: EnvelopeLabels = {
  reconnect: "Reconnect the calendar.",
  stored: "calendar token",
};

export function encryptRefreshToken(plaintext: string, key: Buffer): string {
  return encryptToken(plaintext, key);
}

export function decryptRefreshToken(envelope: string, key: Buffer): string {
  return decryptToken(envelope, key, LABELS);
}
