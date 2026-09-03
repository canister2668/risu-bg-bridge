import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadSeries,
  planSeries,
  applySeries,
  rebaseCheck,
  SeriesError,
  SeriesSchemaError
} from "../scripts/lib/series.mjs";
import { AnchorError } from "../scripts/lib/anchors.mjs";

async function writeSeries(text: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-series-"));
  const p = path.join(tmp, "series.yaml");
  await fs.writeFile(p, text, "utf8");
  return p;
}

const GOOD_SERIES = [
  'series: "test-series"',
  'target: "pocket"',
  'lock: "test.lock.yaml"',
  "steps:",
  '  - id: "s1"',
  '    kind: "replace"',
  '    file: "a.cjs"',
  '    from: "function old() {"',
  '    to: "function new() {"',
  '  - id: "s2"',
  '    kind: "insert"',
  '    file: "a.cjs"',
  '    at: "// END"',
  '    position: "before"',
  "    content: |",
  "      inserted line"
].join("\n");

const PRISTINE = "function old() {}\n// END\n";

test("apply: loadSeries rejects malformed series files fail-closed", async () => {
  const cases: Array<[string, string]> = [
    ["missing steps key", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\n'],
    ["empty steps", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:'],
    ["unknown top-level key", GOOD_SERIES + '\nbogus: "nope"\n'],
    ["duplicate step id", GOOD_SERIES + '\n  - id: "s1"\n    kind: "insert"\n    file: "a.cjs"\n    at: "x"\n    content: "y"\n'],
    ["unknown step kind", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "sed"\n    file: "a.cjs"\n    from: "a"\n    to: "b"\n'],
    ["unknown step field", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "replace"\n    file: "a.cjs"\n    from: "a"\n    to: "b"\n    regex: true\n'],
    ["unsafe file path", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "replace"\n    file: "../outside.cjs"\n    from: "a"\n    to: "b"\n'],
    ["bad step id", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "Not_Legal"\n    kind: "replace"\n    file: "a.cjs"\n    from: "a"\n    to: "b"\n'],
    ["replace without from", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "replace"\n    file: "a.cjs"\n    to: "b"\n'],
    ["insert without at", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "insert"\n    file: "a.cjs"\n    content: "b"\n'],
    ["bad position", 'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "s1"\n    kind: "insert"\n    file: "a.cjs"\n    at: "a"\n    position: "middle"\n    content: "b"\n']
  ];
  for (const [label, text] of cases) {
    const p = await writeSeries(text);
    await assert.rejects(() => loadSeries(fs, p), SeriesSchemaError, label);
  }
});

test("apply: planSeries applies replace and insert in order, in memory", async () => {
  const series = await loadSeries(fs, await writeSeries(GOOD_SERIES));
  const plan = planSeries(series, new Map([["a.cjs", PRISTINE]]));

  assert.deepEqual(
    plan.results.map((r) => `${r.id}:${r.action}`),
    ["s1:applied", "s2:applied"]
  );
  assert.equal(plan.outputs.get("a.cjs"), "function new() {}\ninserted line\n// END\n");
  assert.deepEqual([...plan.touched], ["a.cjs"]);
});

test("apply: replanning against the planned output reports already-applied (idempotent)", async () => {
  const series = await loadSeries(fs, await writeSeries(GOOD_SERIES));
  const first = planSeries(series, new Map([["a.cjs", PRISTINE]]));
  const second = planSeries(series, first.outputs);
  assert.deepEqual(
    second.results.map((r) => `${r.id}:${r.action}`),
    ["s1:already-applied", "s2:already-applied"]
  );
  // Idempotent replanning must not change the bytes.
  assert.equal(second.outputs.get("a.cjs"), first.outputs.get("a.cjs"));
});

test("apply: drifted sources produce unambiguous errors, never guesses", async () => {
  const series = await loadSeries(fs, await writeSeries(GOOD_SERIES));

  // 'from' present twice — ambiguous. planSeries throws synchronously.
  assert.throws(
    () => planSeries(series, new Map([["a.cjs", "function old() { function old() {}\n// END\n"]])),
    SeriesError
  );

  // 'from' absent AND 'to' absent — neither applyable nor already-applied.
  assert.throws(
    () => planSeries(series, new Map([["a.cjs", "unrelated bytes\n"]])),
    SeriesError
  );

  // Insert with content already present twice — ambiguous.
  const dupInsert = await loadSeries(
    fs,
    await writeSeries(
      'series: "x"\ntarget: "pocket"\nlock: "l.yaml"\nsteps:\n  - id: "i"\n    kind: "insert"\n    file: "a.cjs"\n    at: "// END"\n    content: "inserted line"\n'
    )
  );
  assert.throws(
    () => planSeries(dupInsert, new Map([["a.cjs", "inserted line inserted line // END\n"]])),
    SeriesError
  );

  // Insert anchor not present exactly once.
  assert.throws(
    () => planSeries(dupInsert, new Map([["a.cjs", "no anchor here\n"]])),
    SeriesError
  );

  // Step targets a file the snapshot does not carry.
  assert.throws(
    () => planSeries(series, new Map([["other.cjs", PRISTINE]])),
    (err: unknown) => err instanceof SeriesError && /not present in the verified snapshot/.test(err.message)
  );
});

test("apply: named pre-step anchors gate each step against current content", async () => {
  const withAnchors = await loadSeries(
    fs,
    await writeSeries(
      [
        'series: "x"',
        'target: "pocket"',
        'lock: "l.yaml"',
        "steps:",
        '  - id: "s1"',
        '    kind: "replace"',
        '    file: "a.cjs"',
        "    anchors:",
        "      wiring:",
        '        kind: "exact"',
        '        text: "// END"',
        '    from: "function old() {"',
        '    to: "function new() {"'
      ].join("\n")
    )
  );

  // Anchor present: step applies.
  const ok = planSeries(withAnchors, new Map([["a.cjs", PRISTINE]]));
  assert.equal(ok.results[0].action, "applied");

  // Anchor absent: the step must not apply and nothing is written.
  assert.throws(
    () => planSeries(withAnchors, new Map([["a.cjs", "function old() {}\n"]])),
    AnchorError
  );
});

test("apply: applySeries is the only phase that writes, and write=false writes nothing", async () => {
  const series = await loadSeries(fs, await writeSeries(GOOD_SERIES));
  const plan = planSeries(series, new Map([["a.cjs", PRISTINE]]));

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-apply-"));
  const written = await applySeries(fs, plan, outDir);
  assert.equal(written.length, 1);
  assert.equal(await fs.readFile(path.join(outDir, "a.cjs"), "utf8"), plan.outputs.get("a.cjs"));

  const outDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-applynow-"));
  await applySeries(fs, plan, outDir2, { write: false });
  assert.deepEqual(await fs.readdir(outDir2), []);

  // applySeries only accepts the result of a successful planSeries.
  await assert.rejects(() => applySeries(fs, { bogus: true } as any, outDir2), SeriesError);
});

test("apply: rebaseCheck classifies clean and drifted series", async () => {
  const series = await loadSeries(fs, await writeSeries(GOOD_SERIES));

  const clean = rebaseCheck(series, new Map([["a.cjs", PRISTINE]]));
  assert.equal(clean.ok, true);
  assert.equal(clean.results?.[0].action, "applied");

  const drifted = rebaseCheck(series, new Map([["a.cjs", "totally different\n"]]));
  assert.equal(drifted.ok, false);
  assert.ok(drifted.error instanceof SeriesError);

  // A series targeting a file the sources do not carry is drift too — the
  // rebase report must say so, not crash.
  const missing = rebaseCheck(series, new Map());
  assert.equal(missing.ok, false);
  assert.ok(missing.error instanceof SeriesError);
  assert.match(missing.error.message, /not present in the verified snapshot/);
});