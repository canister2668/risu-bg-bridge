import { createHash } from "crypto";
import { JobMetadata, JobState } from "../contract/types.js";

/**
 * Defines the strict directed graph of valid state transitions.
 */
const VALID_TRANSITIONS: Record<JobState, Set<JobState>> = {
  reserved: new Set<JobState>(["queued", "cancelled", "failed"]),
  queued: new Set<JobState>(["running", "cancelled", "failed"]),
  running: new Set<JobState>(["awaiting_tool", "ambiguous", "failed", "cancelled", "succeeded", "queued"]),
  awaiting_tool: new Set<JobState>(["running", "cancelled", "failed"]),
  // Ambiguous execution is not automatically re-queued. An explicit operator
  // or provider-specific resume path must fail, cancel, or introduce a new job.
  ambiguous: new Set<JobState>(["failed", "cancelled"]),
  succeeded: new Set<JobState>(["finalizing", "completed", "cancelled", "failed"]),
  finalizing: new Set<JobState>(["completed", "succeeded", "failed"]),
  completed: new Set<JobState>([]), // terminal
  failed: new Set<JobState>([]), // terminal
  cancelled: new Set<JobState>([]) // terminal
};

/**
 * Checks whether a transition from `from` state to `to` state is valid according to the state machine.
 */
export function validateTransition(from: JobState, to: JobState): boolean {
  if (from === to) {
    return true; // No-op self transitions are allowed
  }
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/**
 * Computes a SHA-256 hash string for any result payload for verification.
 */
export function calculatePayloadHash(payload: any): string {
  if (payload === null || payload === undefined) {
    return "";
  }
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Validates terminal completeness rules for the job.
 * - When in 'succeeded' or 'completed' states, result hash and reference must be present.
 * - If resultPayload is provided, the hash of that payload must match the metadata's resultHash.
 */
export function verifyTerminalCompleteness(job: JobMetadata, resultPayload?: any): boolean {
  const { state } = job.recovery;

  if (state === "succeeded" || state === "completed") {
    if (!job.result) {
      return false;
    }
    if (!job.result.resultHash || !job.result.resultRef) {
      return false;
    }
    if (resultPayload !== undefined) {
      const computedHash = calculatePayloadHash(resultPayload);
      if (computedHash !== job.result.resultHash) {
        return false;
      }
    }
  }

  if (state === "failed") {
    // A failed job should record a finish reason or terminal error
    if (!job.result?.finishReason && !job.result?.terminalSignal && !job.recovery.ambiguousReason) {
      // Though it's good practice, we won't strictly fail validation for empty failure details,
      // but we return true if standard failure properties are there.
    }
  }

  return true;
}

/**
 * Transitions a JobMetadata to a new state and applies optional modifications.
 * Validates the transition using the state machine, updates standard fields,
 * and asserts terminal completeness.
 */
export function transitionJob(
  job: JobMetadata,
  toState: JobState,
  updates?: Partial<Omit<JobMetadata, "recovery" | "audit">> & {
    recoveryUpdates?: Partial<JobMetadata["recovery"]>;
  }
): JobMetadata {
  const fromState = job.recovery.state;

  if (!validateTransition(fromState, toState)) {
    throw new Error(`InvalidStateTransition: Cannot transition job from '${fromState}' to '${toState}'`);
  }

  const now = new Date().toISOString();

  // Create deep copy of the job to maintain pure functional behavior
  const nextJob: JobMetadata = {
    ...job,
    identity: { ...job.identity, ...updates?.identity },
    execution: { ...job.execution, ...updates?.execution },
    generation: { ...job.generation, ...updates?.generation },
    versioning: { ...job.versioning, ...updates?.versioning },
    result: updates?.result ? { ...job.result, ...updates.result } : job.result,
    delivery: { ...job.delivery, ...updates?.delivery },
    recovery: {
      ...job.recovery,
      state: toState,
      previousState: fromState,
      ...updates?.recoveryUpdates
    },
    audit: {
      ...job.audit,
      updatedAt: now
    }
  };

  // Set timestamps for specific state entries
  if (toState === "running" && !nextJob.audit.startedAt) {
    nextJob.audit.startedAt = now;
  }
  if ((toState === "succeeded" || toState === "failed" || toState === "cancelled") && !nextJob.audit.finishedAt) {
    nextJob.audit.finishedAt = now;
  }
  if (toState === "completed" && !nextJob.audit.finalizedAt) {
    nextJob.audit.finalizedAt = now;
  }

  // Validate terminal completeness rules
  if (!verifyTerminalCompleteness(nextJob)) {
    throw new Error(
      `TerminalCompletenessViolation: Job in state '${toState}' must have non-empty resultRef and resultHash.`
    );
  }

  return nextJob;
}
