// The one symmetric-encryption primitive in this app: a self-describing
// envelope for a third-party OAuth credential held at rest in a
// service-role-only table.
//
// EXTRACTED, 2026-09-13, from lib/calendar/crypto.ts, which was its sole
// implementation and remains a caller. The trigger was the second consumer
// (lib/music/spotify/, Spotify's refresh + cached access token). Extraction
// rather than duplication is deliberate and follows this codebase's own
// precedent for lib/safe-redirect.ts: a second hand-rolled copy of an
// open-redirect guard was judged worse than one shared module, and that
// argument is strictly stronger for AES-GCM. Nothing in the original was
// calendar-specific -- it encrypts a bare string under a Buffer key -- so the
// only thing the move had to preserve was the wording of the errors, which is
// now a caller-supplied label (see EnvelopeLabels).
//
// Why this lives in the app and not in the database: decisions.md's
// 2026-09-11 entry has the full argument, but the short version is that
// pgcrypto is deliberately not installed in this project (0001_seam.sql's own
// header), there is no Vault precedent here, and without Vault the symmetric
// key would have to be passed INTO SQL on every read and write -- crossing
// PostgREST and the wire each time. Encrypting here means the database never
// holds or sees the key, so a database dump is not a token compromise. That
// is the actual threat these columns are encrypted against.
//
// Envelope format, deliberately self-describing:
//
//     v1:<iv base64>:<auth tag base64>:<ciphertext base64>
//
// The version prefix is what makes key rotation possible later without a
// schema change: a v2 reader can recognise and re-wrap v1 rows in place.
// AES-256-GCM (not CBC) because it is authenticated -- a tampered ciphertext
// fails to decrypt rather than silently yielding garbage that would then be
// sent to a third party as a credential.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the GCM-recommended nonce size

/** One error type for one envelope format. Callers re-export it under their
 * own name where that reads better at the call site (lib/calendar/crypto.ts
 * exports it as CalendarCryptoError), but it is deliberately the same class:
 * every caller's correct response to it is identical -- ask the user to
 * reconnect -- so a per-provider subclass would be a distinction no handler
 * acts on. */
export class TokenEnvelopeError extends Error {}

/** What a failure reads like to whoever sees it. `stored` names the thing
 * that could not be read ("calendar token"), `reconnect` is the one action
 * the caller can actually take ("Reconnect the calendar."). Supplied by the
 * caller so this module stays provider-agnostic without the error messages
 * degrading into something generic and unactionable. */
export type EnvelopeLabels = {
  reconnect: string;
  stored: string;
};

/**
 * Decodes a base64 env-var value into a 32-byte key, or returns null if it is
 * absent or the wrong size. Null (rather than a throw) is what lets a status
 * route report "not configured" honestly instead of 500-ing -- and a
 * present-but-wrong-length key counts as not configured, because pretending
 * otherwise would fail later, at the point where a real user is mid-OAuth.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  // Buffer.from(_, "base64") is lenient -- it silently drops invalid
  // characters rather than throwing -- so the length check below is the real
  // validation, not a formality.
  return key.length === KEY_BYTES ? key : null;
}

/** Generates a correctly-sized key, base64-encoded. Referenced by
 * .env.example so an operator has an exact command to run rather than
 * guessing at a format this module would then reject. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptToken(envelope: string, key: Buffer, labels: EnvelopeLabels): string {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new TokenEnvelopeError(`Stored ${labels.stored} is not a recognised envelope.`);
  }
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new TokenEnvelopeError(`Stored ${labels.stored} has unsupported envelope version "${version}".`);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64!, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or tampered ciphertext. Deliberately does not echo the
    // underlying OpenSSL message -- the caller's only correct response is
    // "ask the user to reconnect", and the distinction between the two
    // causes is not something an error string should be leaking.
    throw new TokenEnvelopeError(`Stored ${labels.stored} could not be decrypted. ${labels.reconnect}`);
  }
}
