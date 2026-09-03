// Anchor verification for fail-closed patch application.
//
// An anchor describes a text structure that MUST exist in the target source
// an exact number of times before a step may apply. Every verifier here
// fails closed: an unexpected count (zero, two, or more) is an error, never
// a best-effort guess. Two anchor kinds are supported:
//
//   - exact: plain substring, counted verbatim
//   - token: substring that must additionally sit on JavaScript token
//     boundaries (the match must not be embedded inside a longer identifier
//     or property name). This is a pragmatic structural check — it is NOT
//     a full AST parse. Files using token anchors must say so in the series
//     file, and hash verification of the pristine target remains the real
//     gate upstream of this.
//
// regex anchors are deliberately not supported: regexes are far too easy to
// silently write so that they keep matching after an upstream rewrite.

export class AnchorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AnchorError";
    this.details = details;
  }
}

/** Counts verbatim occurrences of `needle` in `source` (non-overlapping). */
export function countExact(source, needle) {
  if (typeof needle !== "string" || needle === "") {
    throw new AnchorError("Anchor text must be a non-empty string");
  }
  if (typeof source !== "string") {
    throw new AnchorError("Target content must be a string");
  }
  if (!source.includes(needle)) return 0;
  return source.split(needle).length - 1;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Counts occurrences of `needle` that additionally begin and end on token
 * boundaries: if the first/last character of the needle is an identifier
 * character, the character just outside the match must not be one. This
 * rejects `createModelJobs` matching inside `createModelJobsV2` or
 * `.createModelJobsX` while allowing matches inside larger statements.
 */
export function countToken(source, needle) {
  const total = countExact(source, needle);
  if (total === 0) return 0;

  let count = 0;
  let idx = source.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? source[idx - 1] : "";
    const end = idx + needle.length;
    const after = end < source.length ? source[end] : "";
    const startsOk = !IDENT_CHAR.test(needle[0]) || !IDENT_CHAR.test(before);
    const endsOk = !IDENT_CHAR.test(needle[needle.length - 1]) || !IDENT_CHAR.test(after);
    if (startsOk && endsOk) count++;
    idx = source.indexOf(needle, idx + 1);
  }
  return count;
}

/**
 * Verifies an anchor against source content.
 *
 * anchor: { kind: "exact" | "token", text: string, expect?: number }
 * label:  human-readable step/anchor identity for error messages.
 * Returns the actual count when it matches; throws AnchorError otherwise.
 */
export function verifyAnchor(source, anchor, label) {
  const kind = anchor?.kind ?? "exact";
  const expected = anchor?.expect ?? 1;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new AnchorError(`${label}: invalid anchor expect value`, { anchor });
  }
  if (typeof anchor?.text !== "string" || anchor.text === "") {
    throw new AnchorError(`${label}: anchor text must be a non-empty string`, { anchor });
  }
  if (kind !== "exact" && kind !== "token") {
    throw new AnchorError(
      `${label}: unsupported anchor kind '${kind}' (allowed: exact, token)`,
      { anchor }
    );
  }

  const actual = kind === "token" ? countToken(source, anchor.text) : countExact(source, anchor.text);
  if (actual !== expected) {
    const firstLine = anchor.text.split("\n")[0];
    throw new AnchorError(
      `${label}: anchor ${kind} count ${actual} != expected ${expected} for text starting with: ${JSON.stringify(firstLine)}`,
      { label, kind, expected, actual, firstLine }
    );
  }
  return actual;
}

/**
 * Verifies every named anchor in a map ({ name: anchor }) against source.
 * All anchors are checked; the error names every failure, not just the first.
 */
export function verifyAnchors(source, anchors, labelPrefix) {
  const failures = [];
  for (const [name, anchor] of Object.entries(anchors ?? {})) {
    try {
      verifyAnchor(source, anchor, `${labelPrefix} anchor '${name}'`);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    const combined = new AnchorError(
      `${labelPrefix}: ${failures.length} anchor verification failure(s):\n` +
        failures.map((f) => `  - ${f.message}`).join("\n")
    );
    combined.details.failures = failures;
    throw combined;
  }
}