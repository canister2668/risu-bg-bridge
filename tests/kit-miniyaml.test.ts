import test from "node:test";
import assert from "node:assert/strict";

import { parseYaml, YamlSyntaxError } from "../scripts/lib/miniyaml.mjs";

test("miniyaml: nested maps, scalars, and comments", () => {
  const doc = parseYaml([
    "# leading comment",
    "target: \"pocket\"",
    "lockFormat: 1",
    "upstream:",
    "  product: PocketRisu",
    "  version: \"1.10.0\"",
    "  commit: null",
    "  ratio: 2.5",
    "  enabled: false",
    "# trailing comment"
  ].join("\n"));
  assert.equal(doc.target, "pocket");
  assert.equal(doc.lockFormat, 1);
  assert.equal(doc.upstream.product, "PocketRisu");
  assert.equal(doc.upstream.version, "1.10.0");
  assert.equal(doc.upstream.commit, null);
  assert.equal(doc.upstream.ratio, 2.5);
  assert.equal(doc.upstream.enabled, false);
});

test("miniyaml: lists of scalars and lists of maps with continuation", () => {
  const doc = parseYaml([
    "notes:",
    "  - first",
    "  - second",
    "steps:",
    "  - id: one",
    "    kind: replace",
    "    file: a.cjs",
    "  - id: two",
    "    kind: insert",
    "    file: b.cjs",
    "    position: before"
  ].join("\n"));
  assert.deepEqual(doc.notes, ["first", "second"]);
  assert.equal(doc.steps.length, 2);
  assert.deepEqual(doc.steps[0], { id: "one", kind: "replace", file: "a.cjs" });
  assert.deepEqual(doc.steps[1], { id: "two", kind: "insert", file: "b.cjs", position: "before" });
});

test("miniyaml: block scalar preserves interior blank lines and # verbatim", () => {
  const doc = parseYaml([
    "from: |8-",
    "        line one # not a comment",
    "",
    "        line after blank"
  ].join("\n"));
  assert.equal(doc.from, "line one # not a comment\n\nline after blank");
});

test("miniyaml: explicit |N- keeps source indentation beyond N", () => {
  const doc = parseYaml([
    "to: |8-",
    "                indented code();",
    "                    deeper();"
  ].join("\n"));
  assert.equal(doc.to, "        indented code();\n            deeper();");
});

test("miniyaml: |- strips the final newline, | keeps one", () => {
  const strip = parseYaml("a: |-\n  x\n  y");
  const keep = parseYaml("b: |\n  x\n  y");
  assert.equal(strip.a, "x\ny");
  assert.equal(keep.b, "x\ny\n");
});

test("miniyaml: block scalar with non-ASCII em-dash survives byte-exact", () => {
  const doc = parseYaml("from: |8-\n        // Phase 1 complete — persist");
  assert.equal(doc.from, "// Phase 1 complete — persist");
});

test("miniyaml: tabs are a hard error", () => {
  assert.throws(() => parseYaml("a:\tb"), YamlSyntaxError);
});

test("miniyaml: duplicate keys are a hard error", () => {
  assert.throws(() => parseYaml("a: 1\na: 2"), YamlSyntaxError);
});

test("miniyaml: flow style is rejected", () => {
  assert.throws(() => parseYaml("a: [1, 2]"), YamlSyntaxError);
  assert.throws(() => parseYaml("a: {b: 1}"), YamlSyntaxError);
});

test("miniyaml: unterminated quote is a hard error", () => {
  assert.throws(() => parseYaml('a: "unclosed'), YamlSyntaxError);
});

test("miniyaml: plain scalar containing ': ' is rejected, quoted is fine", () => {
  assert.throws(() => parseYaml("a: b: c"), YamlSyntaxError);
  assert.equal(parseYaml('a: "b: c"').a, "b: c");
});

test("miniyaml: inconsistent block scalar indentation is a hard error", () => {
  assert.throws(
    () => parseYaml(["a: |-", "    one", "   two"].join("\n")),
    YamlSyntaxError
  );
});

test("miniyaml: empty and comment-only documents parse to {}", () => {
  assert.deepEqual(parseYaml(""), {});
  assert.deepEqual(parseYaml("# only a comment\n"), {});
});