// Patch-series engine: two-phase, fail-closed patch application.
//
// A series file (adapters/<target>/series.yaml) describes an ordered list of
// steps against files of a locked target snapshot. Phase 1 (`planSeries`)
// applies every step IN MEMORY against the loaded pristine sources and
// verifies all anchors; a single failure aborts planning and nothing is
// written. Phase 2 (`applySeries`) only runs after a fully successful plan
// and is the only place files are written.
//
// Step forms:
//
//   replace: anchor `from` (exact or token count 1) is substituted by `to`.
//            Idempotent: if `from` is gone and `to` is present exactly once,
//            the step records `already-applied` and planning continues.
//
//   insert:  `content` is inserted `after`/`before` anchor `at`.
//            Idempotent: if `content` is already present exactly once and
//            the `at` anchor still resolves, the step records
//            `already-applied`.
//
// Anything ambiguous — from present twice, from gone AND to gone, insert
// content present twice — is a hard error telling the human to rebase the
// series, never a best-effort guess.

import { AnchorError, countExact, verifyAnchors } from "./anchors.mjs";
import { loadYamlFile } from "./miniyaml.mjs";

export class SeriesError extends Error {
  constructor(message, stepId) {
    super(stepId ? `${stepId}: ${message}` : message);
    this.name = "SeriesError";
    this.stepId = stepId;
  }
}

export class SeriesSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeriesSchemaError";
  }
}

const POSITION_VALUES = ["before", "after"];

/**
 * Loads and structurally validates a series file. Validation is fail-closed:
 * unknown step fields, unknown step kinds, or a missing `steps` list are all
 * errors, so a typo in a series file can never silently do nothing.
 */
export async function loadSeries(fs, seriesPath) {
  const series = await loadYamlFile(fs, seriesPath);

  for (const key of ["series", "target", "lock", "steps"]) {
    if (!Object.prototype.hasOwnProperty.call(series, key)) {
      throw new SeriesSchemaError(`${seriesPath}: missing required key '${key}'`);
    }
  }
  const allowedTop = new Set(["series", "target", "lock", "steps", "notes"]);
  for (const key of Object.keys(series)) {
    if (!allowedTop.has(key)) {
      throw new SeriesSchemaError(`${seriesPath}: unknown top-level key '${key}'`);
    }
  }
  if (!Array.isArray(series.steps) || series.steps.length === 0) {
    throw new SeriesSchemaError(`${seriesPath}: 'steps' must be a non-empty list`);
  }

  const seenIds = new Set();
  for (const step of series.steps) {
    const id = step.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new SeriesSchemaError(`${seriesPath}: every step needs a lowercase-hyphen 'id'`);
    }
    if (seenIds.has(id)) throw new SeriesSchemaError(`${seriesPath}: duplicate step id '${id}'`);
    seenIds.add(id);

    if (typeof step.file !== "string" || step.file === "" || step.file.includes("..") || step.file.startsWith("/")) {
      throw new SeriesSchemaError(`${seriesPath}:${id}: 'file' must be a safe relative path`);
    }

    const kind = step.kind;
    if (kind === "replace") {
      const allowed = new Set(["id", "kind", "file", "description", "anchors", "from", "to"]);
      for (const key of Object.keys(step)) {
        if (!allowed.has(key)) throw new SeriesSchemaError(`${seriesPath}:${id}: unknown field '${key}'`);
      }
      if (typeof step.from !== "string" || step.from === "") {
        throw new SeriesSchemaError(`${seriesPath}:${id}: replace step requires non-empty 'from'`);
      }
      if (typeof step.to !== "string") {
        throw new SeriesSchemaError(`${seriesPath}:${id}: replace step requires string 'to'`);
      }
    } else if (kind === "insert") {
      const allowed = new Set(["id", "kind", "file", "description", "anchors", "at", "position", "content"]);
      for (const key of Object.keys(step)) {
        if (!allowed.has(key)) throw new SeriesSchemaError(`${seriesPath}:${id}: unknown field '${key}'`);
      }
      if (typeof step.at !== "string" || step.at === "") {
        throw new SeriesSchemaError(`${seriesPath}:${id}: insert step requires non-empty 'at'`);
      }
      if (typeof step.content !== "string") {
        throw new SeriesSchemaError(`${seriesPath}:${id}: insert step requires string 'content'`);
      }
      const position = step.position ?? "after";
      if (!POSITION_VALUES.includes(position)) {
        throw new SeriesSchemaError(
          `${seriesPath}:${id}: 'position' must be one of ${POSITION_VALUES.join(", ")}`
        );
      }
    } else {
      throw new SeriesSchemaError(
        `${seriesPath}:${id}: unknown step kind ${JSON.stringify(kind)} (allowed: replace, insert)`
      );
    }

    // anchors are an optional map of named preconditions checked before the
    // step runs, e.g. requiring a second anchor to still be unique.
    if (step.anchors !== undefined && step.anchors !== null) {
      if (typeof step.anchors !== "object" || Array.isArray(step.anchors)) {
        throw new SeriesSchemaError(`${seriesPath}:${id}: 'anchors' must be a map`);
      }
    }
  }

  return series;
}

function applyReplaceStep(content, step, stepId) {
  const fromCount = countExact(content, step.from);
  const toCount = countExact(content, step.to);

  if (fromCount === 1 && toCount === 0) {
    const idx = content.indexOf(step.from);
    return {
      action: "applied",
      content: content.slice(0, idx) + step.to + content.slice(idx + step.from.length),
    };
  }
  if (fromCount === 0 && toCount === 1) {
    return { action: "already-applied", content };
  }
  throw new SeriesError(
    `replace is ambiguous: 'from' count ${fromCount}, 'to' count ${toCount}. ` +
      `Expected (from=1,to=0) to apply or (from=0,to=1) to be already applied. ` +
      `The target has drifted from the locked source — rebase this series.`,
    stepId
  );
}

function applyInsertStep(content, step, stepId) {
  const atCount = countExact(content, step.at);
  const contentCount = countExact(content, step.content);

  if (contentCount === 1) {
    if (atCount !== 1) {
      throw new SeriesError(
        `insert 'content' already present once but 'at' anchor count is ${atCount} (expected 1) — ` +
          `the target has drifted; verify by hand before treating this step as already applied`,
        stepId
      );
    }
    return { action: "already-applied", content };
  }
  if (contentCount > 1) {
    throw new SeriesError(`insert 'content' appears ${contentCount} times — ambiguous`, stepId);
  }
  if (atCount !== 1) {
    throw new SeriesError(
      `insert 'at' anchor count ${atCount} (expected exactly 1) — anchor not found or target drifted`,
      stepId
    );
  }

  const idx = content.indexOf(step.at);
  const insertAt = step.position === "before" ? idx : idx + step.at.length;
  return {
    action: "applied",
    content: content.slice(0, insertAt) + step.content + content.slice(insertAt),
  };
}

/**
 * Phase 1: plans every step against in-memory sources.
 *
 * sources: Map<relPath, string> — the pristine locked contents.
 * Returns { results: [{id, file, action, anchors}], outputs: Map<relPath, string> }.
 * On any step failure, throws (SeriesError or AnchorError) — nothing written.
 */
export function planSeries(series, sources) {
  const outputs = new Map(sources);
  const results = [];
  const touched = new Set();

  for (const step of series.steps) {
    const stepId = step.id;
    const raw = outputs.get(step.file);
    if (raw === undefined) {
      throw new SeriesError(
        `step targets file '${step.file}' which is not present in the verified snapshot ` +
          `(available: ${[...sources.keys()].sort().join(", ")})`,
        stepId
      );
    }

    // Optional pre-step named anchors must all verify against the CURRENT
    // (possibly already patched) content, so later steps can assert earlier
    // steps landed where expected.
    if (step.anchors) {
      verifyAnchors(raw, step.anchors, `${series.series}:${stepId}`);
    }

    let outcome;
    if (step.kind === "replace") {
      outcome = applyReplaceStep(raw, step, stepId);
    } else {
      outcome = applyInsertStep(raw, step, stepId);
    }

    outputs.set(step.file, outcome.content);
    touched.add(step.file);
    results.push({ id: stepId, file: step.file, action: outcome.action, anchors: step.anchors ?? null });
  }

  return { results, outputs, touched };
}

/**
 * Phase 2: writes planned outputs to disk. Only valid on the result of a
 * successful planSeries — callers must pass that exact object.
 */
export async function applySeries(fs, plan, outDir, { write = true } = {}) {
  if (!plan || !plan.outputs || !Array.isArray(plan.results)) {
    throw new SeriesError("applySeries requires the result of a successful planSeries call");
  }
  const written = [];
  for (const [relPath, content] of plan.outputs) {
    const dest = `${outDir}/${relPath}`;
    if (write) {
      await fs.writeFile(dest, content, "utf8");
    }
    written.push(dest);
  }
  return written;
}

/**
 * Rebase check: plans the series against the given sources and classifies
 * each step as applied / already-applied / failed. `checkOnly` never writes.
 * This is what `scripts/rebase-check.mjs` runs after an upstream refresh.
 */
export function rebaseCheck(series, sources) {
  try {
    const plan = planSeries(series, sources);
    return { ok: true, results: plan.results };
  } catch (err) {
    if (err instanceof AnchorError || err instanceof SeriesError) {
      return { ok: false, error: err, results: null };
    }
    throw err;
  }
}