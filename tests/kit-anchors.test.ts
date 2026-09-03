import test from "node:test";
import assert from "node:assert/strict";

import {
  AnchorError,
  countExact,
  countToken,
  verifyAnchor,
  verifyAnchors
} from "../scripts/lib/anchors.mjs";

test("anchors: countExact counts verbatim occurrences", () => {
  const src = "const a = createModelJobs();\nconst b = createModelJobs();\n";
  assert.equal(countExact(src, "createModelJobs"), 2);
  assert.equal(countExact(src, "nope"), 0);
  assert.equal(countExact("xyzxyz".repeat(3), "xyzxyz"), 3);
});

test("anchors: countExact fails closed on bad inputs", () => {
  assert.throws(() => countExact("src", ""), AnchorError);
  assert.throws(() => countExact("src", null), AnchorError);
  assert.throws(() => countExact(null, "needle"), AnchorError);
  assert.throws(() => countExact(42, "needle"), AnchorError);
});

test("anchors: countToken rejects matches embedded in longer identifiers", () => {
  // Embedded at the END: createModelJobsV2 is not the anchored token.
  assert.equal(countToken("const x = createModelJobsV2();", "createModelJobs"), 0);
  // Embedded at the START: xcreateModelJobs is not the anchored token.
  assert.equal(countToken("const x = xcreateModelJobs();", "createModelJobs"), 0);
  // Plain occurrence with punctuation boundaries counts.
  assert.equal(countToken("const x = createModelJobs();", "createModelJobs"), 1);
  // Property access and require() boundaries are still token boundaries.
  assert.equal(countToken("const m = mod.createModelJobs; require('./createModelJobs')", "createModelJobs"), 2);
});

test("anchors: token needles with non-identifier edges are boundary-checked leniently", () => {
  // Needles that start/end with a non-identifier character only check the
  // identifier side; quoting context does not matter (this is a textual
  // structural check, not an AST — documented limitation).
  assert.equal(countToken("x = 'Phase 1 complete — persist';", "Phase 1 complete"), 1);
  // A needle that begins with an identifier character still requires a token
  // boundary before it, even when the needle ends in a word character.
  assert.equal(countToken("x = aPhase 1 complete;", "Phase 1 complete"), 0);
});

test("anchors: verifyAnchor enforces the expected count and reports details", () => {
  const src = "one two one two one";
  assert.equal(verifyAnchor(src, { text: "one", expect: 3 }, "step"), 3);
  assert.throws(() => verifyAnchor(src, { text: "one" }, "step"), AnchorError);

  let err;
  try {
    verifyAnchor(src, { kind: "exact", text: "two", expect: 3 }, "step-x");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AnchorError);
  assert.equal(err.details.expected, 3);
  assert.equal(err.details.actual, 2);
  assert.ok(err.message.includes("step-x"));
  assert.ok(err.message.includes("count 2 != expected 3"));
});

test("anchors: unsupported kinds, empty text, and bad expect fail closed", () => {
  const src = "abc";
  assert.throws(() => verifyAnchor(src, { kind: "regex", text: "a" }, "step"), AnchorError);
  assert.throws(() => verifyAnchor(src, { kind: "exact", text: "" }, "step"), AnchorError);
  assert.throws(() => verifyAnchor(src, { kind: "exact", text: "a", expect: -1 }, "step"), AnchorError);
  assert.throws(() => verifyAnchor(src, { kind: "exact", text: "a", expect: 1.5 }, "step"), AnchorError);
  assert.throws(() => verifyAnchor(src, null, "step"), AnchorError);
});

test("anchors: token kind routes through countToken", () => {
  assert.equal(verifyAnchor("f(createModelJobsV2)", { kind: "token", text: "createModelJobs", expect: 0 }, "s"), 0);
  assert.throws(
    () => verifyAnchor("f(createModelJobsV2)", { kind: "token", text: "createModelJobs" }, "s"),
    AnchorError
  );
  assert.equal(verifyAnchor("f(createModelJobs)", { kind: "token", text: "createModelJobs" }, "s"), 1);
});

test("anchors: verifyAnchors collects every failure, not just the first", () => {
  const src = "alpha beta";
  // No anchors at all: fine.
  verifyAnchors(src, {}, "plan");
  verifyAnchors(src, undefined, "plan");

  let err;
  try {
    verifyAnchors(
      src,
      {
        missing: { kind: "exact", text: "gamma" },
        duplicated: { kind: "exact", text: "alpha", expect: 5 }
      },
      "plan:pocket-001"
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AnchorError);
  assert.equal(err.details.failures.length, 2);
  assert.ok(err.message.includes("2 anchor verification failure(s)"));
  assert.ok(err.message.includes("missing"));
  assert.ok(err.message.includes("duplicated"));
});