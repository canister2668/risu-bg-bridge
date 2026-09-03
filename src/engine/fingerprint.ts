import { createHash } from "crypto";
import { CreateBackgroundJobRequest, JobMetadata, RetryPolicy } from "../contract/types.js";

/**
 * Recursively normalizes a value by sorting object keys for stable JSON.
 * Payload keys are preserved: tool arguments such as `key` or `token` must
 * not be stripped, or distinct requests would collide.
 */
export function canonicalize(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null;
  }

  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }

  if (typeof val === "object") {
    const record = val as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }

  return val;
}

/**
 * SHA-256 fingerprint of invariant job identity.
 * Includes credentialRef and credentialEpoch (non-secret credential identity)
 * so a reserved retry with a rotated credential cannot reuse the job.
 */
export function calculateFingerprint(req: CreateBackgroundJobRequest): string {
  const coreToHash = {
    kind: req.kind,
    providerRef: req.providerRef,
    modelRef: req.modelRef,
    credentialRef: req.credentialRef,
    credentialEpoch: req.credentialEpoch ?? null,
    payload: req.payload,
    generation: req.generation,
    versioning: req.versioning
  };

  const canonicalObj = canonicalize(coreToHash);
  const jsonStr = JSON.stringify(canonicalObj);

  return createHash("sha256").update(jsonStr).digest("hex");
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class CasConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasConflictError";
  }
}

export class JobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobNotFoundError";
  }
}

/**
 * Reference in-memory implementation of the Idempotence Job Registry contract.
 * Ensures clientJobId PUT idempotency and compare-and-set updates:
 * - Same clientJobId + Same fingerprint -> Returns existing job
 * - Same clientJobId + Different fingerprint -> Throws ConflictError
 * - Updates require the caller's expected recordVersion
 */
export class IdempotentJobRegistry {
  private jobs = new Map<string, JobMetadata>();

  private makeKey(principalId: string, clientJobId: string): string {
    return `${principalId}:${clientJobId}`;
  }

  public putJob(
    principalId: string,
    req: CreateBackgroundJobRequest
  ): { job: JobMetadata; isNew: boolean } {
    const key = this.makeKey(principalId, req.clientJobId);
    const existing = this.jobs.get(key);
    const fingerprint = calculateFingerprint(req);

    if (existing) {
      if (existing.identity.requestFingerprint === fingerprint) {
        return { job: existing, isNew: false };
      }
      throw new ConflictError(
        `Conflict: Job '${req.clientJobId}' already exists with a different request fingerprint`
      );
    }

    const defaultRetryPolicy: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffFactor: 2,
      idempotencySupported: false,
      ...req.retryPolicy
    };

    const newJob: JobMetadata = {
      recordVersion: 1,
      identity: {
        principalId,
        clientJobId: req.clientJobId,
        requestFingerprint: fingerprint
      },
      kind: req.kind,
      execution: {
        providerRef: req.providerRef,
        modelRef: req.modelRef,
        credentialRef: req.credentialRef,
        credentialEpoch: req.credentialEpoch,
        requestEnvelopeRef: `envelope://${principalId}/${req.clientJobId}`,
        attempt: 1,
        executionEpoch: 1
      },
      generation: {
        chatId: req.generation.chatId,
        characterId: req.generation.characterId,
        generationId: req.generation.generationId,
        mode: req.generation.mode,
        expectedChatRevision: req.generation.expectedChatRevision
      },
      versioning: {
        contractVersion: req.versioning.contractVersion,
        jobSchemaVersion: 1,
        pipelineVersion: req.versioning.pipelineVersion,
        pluginVersion: req.versioning.pluginVersion,
        adapterVersion: "1.0.0"
      },
      recovery: {
        state: "reserved",
        retryPolicy: defaultRetryPolicy
      },
      delivery: {
        deliveryState: "undelivered",
        fencingToken: 0n
      },
      audit: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };

    this.jobs.set(key, newJob);
    return { job: newJob, isNew: true };
  }

  public getJob(principalId: string, clientJobId: string): JobMetadata | undefined {
    return this.jobs.get(this.makeKey(principalId, clientJobId));
  }

  /**
   * Compare-and-set replacement. `expectedVersion` must match the stored
   * recordVersion; on success the stored version is incremented.
   */
  public updateJob(
    principalId: string,
    clientJobId: string,
    expectedVersion: number,
    nextJob: JobMetadata
  ): JobMetadata {
    const key = this.makeKey(principalId, clientJobId);
    const existing = this.jobs.get(key);
    if (!existing) {
      throw new JobNotFoundError(`Job '${clientJobId}' not found under principal '${principalId}'`);
    }
    if (existing.recordVersion !== expectedVersion) {
      throw new CasConflictError(
        `CAS conflict for job '${clientJobId}': expected version ${expectedVersion}, found ${existing.recordVersion}`
      );
    }
    if (
      nextJob.identity.principalId !== principalId ||
      nextJob.identity.clientJobId !== clientJobId
    ) {
      throw new ConflictError("CAS update cannot change job identity");
    }

    const stored: JobMetadata = {
      ...nextJob,
      recordVersion: existing.recordVersion + 1
    };
    this.jobs.set(key, stored);
    return stored;
  }

  public listJobs(principalId: string): JobMetadata[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.identity.principalId === principalId
    );
  }

  public deleteJob(principalId: string, clientJobId: string): boolean {
    return this.jobs.delete(this.makeKey(principalId, clientJobId));
  }
}
