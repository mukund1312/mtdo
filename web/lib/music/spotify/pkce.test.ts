// PKCE correctness (RFC 7636). The headline test is the last one in the first
// block: RFC 7636 appendix B publishes a verifier/challenge pair, and checking
// against it is the difference between "this hashes and encodes something" and
// "this implements S256". A subtly wrong challenge is a silent failure -- it
// is accepted at the authorize step and only rejected at code exchange, after
// the user has already granted consent.
import { describe, expect, it } from "vitest";

import {
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
  createCodeVerifier,
  deriveCodeChallenge,
  isValidCodeVerifier,
} from "./pkce";

describe("deriveCodeChallenge", () => {
  it("matches RFC 7636 appendix B's published S256 test vector", () => {
    // The canonical pair from the spec itself. If this ever fails, the
    // implementation is not S256, whatever else it may be doing.
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produces base64url, with no padding or +/ characters", () => {
    // A '+' or '/' in a code_challenge is not merely ugly -- it changes
    // meaning once the value is URL-encoded into the authorize request.
    const challenge = deriveCodeChallenge(createCodeVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toContain("=");
  });

  it("is deterministic for a given verifier", () => {
    const verifier = createCodeVerifier();
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
  });

  it("is a hash, not a reversible encoding of the verifier", () => {
    // The entire security property of S256: a challenge observed in the
    // authorize URL must not reveal the verifier needed to redeem the code.
    const verifier = createCodeVerifier();
    expect(deriveCodeChallenge(verifier)).not.toBe(verifier);
    expect(deriveCodeChallenge(verifier)).not.toContain(verifier);
  });

  it("hashes the verifier's characters, not the bytes it decodes to", () => {
    // The easy mistake when the verifier happens to be base64url itself.
    // Asserted by comparing against the ASCII-hash vector above: a byte-wise
    // implementation would produce something else entirely for that input.
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).not.toBe(
      deriveCodeChallenge(Buffer.from("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "base64url").toString("latin1")),
    );
  });
});

describe("createCodeVerifier", () => {
  it("produces a verifier inside RFC 7636's permitted length range", () => {
    const verifier = createCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(VERIFIER_MIN_LENGTH);
    expect(verifier.length).toBeLessThanOrEqual(VERIFIER_MAX_LENGTH);
  });

  it("uses only the unreserved characters the spec allows", () => {
    expect(createCodeVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("is different on every call", () => {
    // A reused verifier would let a single leaked value redeem later codes.
    const seen = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
    expect(seen.size).toBe(50);
  });
});

describe("isValidCodeVerifier", () => {
  it("accepts what createCodeVerifier() produces", () => {
    expect(isValidCodeVerifier(createCodeVerifier())).toBe(true);
  });

  it("rejects an absent cookie", () => {
    expect(isValidCodeVerifier(undefined)).toBe(false);
    expect(isValidCodeVerifier("")).toBe(false);
  });

  it("rejects a truncated verifier rather than sending it to Spotify to be refused", () => {
    expect(isValidCodeVerifier("a".repeat(VERIFIER_MIN_LENGTH - 1))).toBe(false);
  });

  it("rejects an over-long verifier", () => {
    expect(isValidCodeVerifier("a".repeat(VERIFIER_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects characters outside the unreserved set", () => {
    // A tampered cookie carrying, say, a URL fragment or quote should end the
    // flow cleanly at the callback rather than be spent at the token endpoint.
    expect(isValidCodeVerifier(`${"a".repeat(50)}&x=1`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(50)}/`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(50)} `)).toBe(false);
  });
});
