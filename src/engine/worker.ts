import { randomUUID } from "node:crypto";
import {
  JobMetadata,
  JobState,
  JobEvent,
  JobResult,
  CredentialResolver
} from "../contract/types.js";
import { BgStorageEngine } from "../storage/interface.js";
import { transitionJob, calculatePayloadHash } from "./stateMachine.js";
import { RetryPolicyEngine, RetryEvidence, ErrorType } from "./retry.js";
import { ToolExecutionEngine } from "./tools.js";

export interface ModelExecutionHandler {
  execute(
    job: JobMetadata,
    requestPayload: any,
    credentialSecret: Record<string, any>,
    signal?: AbortSignal
  ): Promise<{
    result: any;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: string;
  }>;
}

export interface WorkerOptions {
  workerId?: string;
  leaseDurationMs?: number;
}

/**
 * Production-grade background worker and restart recovery engine.
 * Responsibilities:
 * 1. Claiming queued jobs with execution epoch increments.
 * 2. Resolving credentials via CredentialResolver without storing secrets.
 * 3. Handling provider invocation and appending events to typed journal.
 * 4. Restart recovery: discovering active jobs (running, awaiting_tool, finalizing)
 *    and resolving to retry / resume / ambiguous based on provider idempotency.
 */
export class BackgroundWorker {
  public readonly workerId: string;
  private leaseDurationMs: number;
  private isRunning = false;

  constructor(
    private storage: BgStorageEngine,
    private credentialResolver: CredentialResolver,
    private modelHandler: ModelExecutionHandler,
    private toolEngine?: ToolExecutionEngine,
    options: WorkerOptions = {}
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
  }

  /**
   * Run restart recovery for any active jobs left in-flight after a crash or restart.
   * - 'running' jobs:
   *    If provider request was sent or uncertain and idempotency not supported -> 'ambiguous'.
   *    If retryable under policy -> 'queued' with incremented attempt.
   *    If credentials revoked or epoch changed -> 'failed' / 'blocked_credential'.
   * - 'finalizing' jobs:
   *    Reverted to 'succeeded' with expired delivery lease so another client can re-claim.
   * - 'awaiting_tool' jobs:
   *    Preserved in 'awaiting_tool' with tool checkpoints preserved.
   */
  public async runRestartRecovery(): Promise<{
    recoveredCount: number;
    states: Record<string, JobState>;
  }> {
    const activeJobs = await this.storage.listActiveJobs();
    const states: Record<string, JobState> = {};
    let recoveredCount = 0;

    for (const job of activeJobs) {
      const jobId = job.identity.clientJobId;
      const principalId = job.identity.principalId;

      if (job.recovery.state === "finalizing") {
        // Expired lease during server crash: return to 'succeeded' so client can re-acquire lease
        const updated = transitionJob(job, "succeeded", {
          delivery: {
            deliveryState: "undelivered",
            fencingToken: job.delivery.fencingToken,
            leaseOwner: undefined,
            leaseId: undefined,
            leaseExpiresAt: undefined
          }
        });
        await this.storage.updateJobCas(principalId, jobId, job.recordVersion, updated);
        await this.storage.appendEvent({
          jobId,
          seq: (await this.storage.getEvents(jobId)).length + 1,
          eventId: randomUUID(),
          type: "state",
          createdAt: new Date().toISOString(),
          payload: { state: "succeeded", reason: "RestartRecovery: Cleared stale finalize lease" }
        });
        states[jobId] = "succeeded";
        recoveredCount++;
        continue;
      }

      if (job.recovery.state === "awaiting_tool") {
        // Keep in awaiting_tool; checkpoint state is preserved in DB
        states[jobId] = "awaiting_tool";
        recoveredCount++;
        continue;
      }

      if (job.recovery.state === "running") {
        // Crash during model call: evaluate retry vs ambiguous
        const credRes = await this.credentialResolver.resolveCredential(
          job.execution.credentialRef,
          job.execution.credentialEpoch
        );

        if (credRes.status === "blocked_credential" || credRes.status === "failed_credential") {
          const failed = transitionJob(job, "failed", {
            recoveryUpdates: {
              ambiguousReason: `BlockedCredentialOnRestart: ${credRes.reason}`
            },
            result: {
              terminalSignal: credRes.reason,
              finishReason: "credential_error"
            }
          });
          await this.storage.updateJobCas(principalId, jobId, job.recordVersion, failed);
          await this.storage.appendEvent({
            jobId,
            seq: (await this.storage.getEvents(jobId)).length + 1,
            eventId: randomUUID(),
            type: "state",
            createdAt: new Date().toISOString(),
            payload: { state: "failed", reason: credRes.reason }
          });
          states[jobId] = "failed";
          recoveredCount++;
          continue;
        }

        // Provider idempotency evaluation:
        // A server crash while running means send was uncertain (could have reached provider)
        const retryEval = RetryPolicyEngine.evaluate(
          job,
          "CRASH",
          new Date(),
          { requestSent: "unknown" }
        );

        if (retryEval.action === "ambiguous") {
          const ambiguousJob = transitionJob(job, "ambiguous", {
            recoveryUpdates: {
              ambiguousReason: retryEval.reason
            }
          });
          await this.storage.updateJobCas(principalId, jobId, job.recordVersion, ambiguousJob);
          await this.storage.appendEvent({
            jobId,
            seq: (await this.storage.getEvents(jobId)).length + 1,
            eventId: randomUUID(),
            type: "state",
            createdAt: new Date().toISOString(),
            payload: { state: "ambiguous", reason: retryEval.reason }
          });
          states[jobId] = "ambiguous";
          recoveredCount++;
        } else if (retryEval.action === "retry") {
          // Can safely re-queue
          const requeuedJob = transitionJob(job, "queued", {
            execution: {
              ...job.execution,
              attempt: job.execution.attempt + 1,
              executionEpoch: job.execution.executionEpoch + 1
            },
            recoveryUpdates: {
              nextRetryAt: retryEval.nextRetryAt
            }
          });
          await this.storage.updateJobCas(principalId, jobId, job.recordVersion, requeuedJob);
          await this.storage.appendEvent({
            jobId,
            seq: (await this.storage.getEvents(jobId)).length + 1,
            eventId: randomUUID(),
            type: "state",
            createdAt: new Date().toISOString(),
            payload: { state: "queued", reason: retryEval.reason }
          });
          states[jobId] = "queued";
          recoveredCount++;
        } else {
          const failed = transitionJob(job, "failed", {
            result: {
              terminalSignal: retryEval.reason,
              finishReason: "restart_abort"
            }
          });
          await this.storage.updateJobCas(principalId, jobId, job.recordVersion, failed);
          await this.storage.appendEvent({
            jobId,
            seq: (await this.storage.getEvents(jobId)).length + 1,
            eventId: randomUUID(),
            type: "state",
            createdAt: new Date().toISOString(),
            payload: { state: "failed", reason: retryEval.reason }
          });
          states[jobId] = "failed";
          recoveredCount++;
        }
      }
    }

    return { recoveredCount, states };
  }

  /**
   * Process a single queued job to completion or awaiting_tool/ambiguous/failed.
   */
  public async executeJob(job: JobMetadata): Promise<JobMetadata> {
    const jobId = job.identity.clientJobId;
    const principalId = job.identity.principalId;

    // Transition queued -> running
    let runningJob = transitionJob(job, "running", {
      execution: {
        ...job.execution,
        executionEpoch: job.execution.executionEpoch + 1
      }
    });

    runningJob = await this.storage.updateJobCas(principalId, jobId, job.recordVersion, runningJob);
    await this.storage.appendEvent({
      jobId,
      seq: (await this.storage.getEvents(jobId)).length + 1,
      eventId: randomUUID(),
      type: "state",
      createdAt: new Date().toISOString(),
      payload: { state: "running", workerId: this.workerId, epoch: runningJob.execution.executionEpoch }
    });

    // 1. Resolve credential
    const credRes = await this.credentialResolver.resolveCredential(
      runningJob.execution.credentialRef,
      runningJob.execution.credentialEpoch
    );

    if (credRes.status !== "resolved") {
      const failed = transitionJob(runningJob, "failed", {
        recoveryUpdates: { ambiguousReason: credRes.reason },
        result: { terminalSignal: credRes.reason, finishReason: "credential_error" }
      });
      const stored = await this.storage.updateJobCas(principalId, jobId, runningJob.recordVersion, failed);
      await this.storage.appendEvent({
        jobId,
        seq: (await this.storage.getEvents(jobId)).length + 1,
        eventId: randomUUID(),
        type: "error",
        createdAt: new Date().toISOString(),
        payload: { error: credRes.reason }
      });
      return stored;
    }

    // 2. Fetch request envelope
    const envelope = await this.storage.getRequestEnvelope(runningJob.execution.requestEnvelopeRef);
    if (!envelope) {
      const failed = transitionJob(runningJob, "failed", {
        result: { terminalSignal: "RequestEnvelopeNotFound", finishReason: "envelope_missing" }
      });
      return this.storage.updateJobCas(principalId, jobId, runningJob.recordVersion, failed);
    }

    // 3. Execute Model
    try {
      const outcome = await this.modelHandler.execute(runningJob, envelope, credRes.secret);
      const resultHash = calculatePayloadHash(outcome.result);

      // Save result blob
      const jobResult: JobResult = {
        jobId,
        resultHash,
        payload: outcome.result,
        usage: outcome.usage,
        finishReason: outcome.finishReason
      };
      await this.storage.saveResult(jobResult);

      // Transition to succeeded
      const succeededJob = transitionJob(runningJob, "succeeded", {
        result: {
          resultRef: `result://${jobId}`,
          resultHash,
          usage: outcome.usage,
          finishReason: outcome.finishReason
        }
      });

      const updated = await this.storage.updateJobCas(principalId, jobId, runningJob.recordVersion, succeededJob);

      await this.storage.appendEvent({
        jobId,
        seq: (await this.storage.getEvents(jobId)).length + 1,
        eventId: randomUUID(),
        type: "result_ready",
        createdAt: new Date().toISOString(),
        payload: { resultHash, usage: outcome.usage }
      });

      return updated;
    } catch (err: any) {
      const errorType: ErrorType = err.name === "AbortError" ? "CRASH" : "SERVER_503";
      const evalResult = RetryPolicyEngine.evaluate(runningJob, errorType, new Date(), {
        requestSent: true
      });

      if (evalResult.action === "ambiguous") {
        const ambiguousJob = transitionJob(runningJob, "ambiguous", {
          recoveryUpdates: { ambiguousReason: evalResult.reason }
        });
        const updated = await this.storage.updateJobCas(principalId, jobId, runningJob.recordVersion, ambiguousJob);
        await this.storage.appendEvent({
          jobId,
          seq: (await this.storage.getEvents(jobId)).length + 1,
          eventId: randomUUID(),
          type: "state",
          createdAt: new Date().toISOString(),
          payload: { state: "ambiguous", reason: evalResult.reason }
        });
        return updated;
      }

      const failedJob = transitionJob(runningJob, "failed", {
        result: { terminalSignal: err.message, finishReason: "execution_error" }
      });
      const updated = await this.storage.updateJobCas(principalId, jobId, runningJob.recordVersion, failedJob);
      await this.storage.appendEvent({
        jobId,
        seq: (await this.storage.getEvents(jobId)).length + 1,
        eventId: randomUUID(),
        type: "error",
        createdAt: new Date().toISOString(),
        payload: { error: err.message }
      });
      return updated;
    }
  }
}
