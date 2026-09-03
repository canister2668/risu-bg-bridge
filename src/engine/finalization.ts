import { createHash } from "node:crypto";
import {
  JobMetadata,
  JobResult,
  DurableGenerationContext,
  FinalizationStageLedgerEntry,
  FinalizationStageStatus,
  MaterializationProof
} from "../contract/types.js";
import { BgStorageEngine } from "../storage/interface.js";
import { calculatePayloadHash } from "./stateMachine.js";

export interface StageDefinition {
  stageId: string;
  stageVersion: number;
  isPureIdempotent: boolean;
  execute: (input: any, ctx: DurableGenerationContext) => Promise<any>;
}

export interface FinalizationOutcome {
  success: boolean;
  finalizedResult?: any;
  error?: string;
  completedStages: string[];
}

export class ChatMaterializationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatMaterializationConflictError";
  }
}

/**
 * Resumable Finalization Pipeline.
 * Executes discrete post-generation stages tracked in a persistent stage ledger.
 * Ensures that recovered jobs re-run only idempotent/incomplete stages and do not
 * duplicate non-idempotent side effects.
 */
export class ResumableFinalizer {
  private stages: StageDefinition[] = [];

  constructor(private storage: BgStorageEngine) {}

  public registerStage(stage: StageDefinition): void {
    this.stages.push(stage);
  }

  /**
   * Processes a job's generation result through the stage pipeline.
   */
  public async processDurableGenerationResult(
    job: JobMetadata,
    rawResult: JobResult,
    ctx: DurableGenerationContext
  ): Promise<FinalizationOutcome> {
    const jobId = job.identity.clientJobId;
    const generationId = ctx.generationId;
    let currentPayload = rawResult.payload;
    const completedStages: string[] = [];

    for (const stage of this.stages) {
      const inputHash = createHash("sha256")
        .update(typeof currentPayload === "string" ? currentPayload : JSON.stringify(currentPayload))
        .digest("hex");

      const existingEntry = await this.storage.getStageEntry(
        jobId,
        generationId,
        stage.stageId,
        stage.stageVersion
      );

      if (existingEntry && existingEntry.status === "completed") {
        // Stage already completed; reuse cached output without repeating side effects
        currentPayload = existingEntry.outputPayload;
        completedStages.push(stage.stageId);
        continue;
      }

      if (existingEntry && existingEntry.status === "blocked") {
        return {
          success: false,
          error: `Stage '${stage.stageId}' is blocked and cannot be auto-executed.`,
          completedStages
        };
      }

      // Record stage running
      const entry: FinalizationStageLedgerEntry = {
        jobId,
        generationId,
        stageId: stage.stageId,
        stageVersion: stage.stageVersion,
        inputHash,
        status: "running",
        attempt: (existingEntry?.attempt ?? 0) + 1
      };
      await this.storage.saveStageEntry(entry);

      try {
        const outputPayload = await stage.execute(currentPayload, ctx);
        const outputHash = createHash("sha256")
          .update(typeof outputPayload === "string" ? outputPayload : JSON.stringify(outputPayload))
          .digest("hex");

        entry.status = "completed";
        entry.outputHash = outputHash;
        entry.outputPayload = outputPayload;
        entry.completedAt = new Date().toISOString();
        await this.storage.saveStageEntry(entry);

        currentPayload = outputPayload;
        completedStages.push(stage.stageId);
      } catch (err: any) {
        entry.status = stage.isPureIdempotent ? "failed" : "blocked";
        entry.error = err.message;
        await this.storage.saveStageEntry(entry);

        return {
          success: false,
          error: `Stage '${stage.stageId}' execution failed: ${err.message}`,
          completedStages
        };
      }
    }

    return {
      success: true,
      finalizedResult: currentPayload,
      completedStages
    };
  }

  /**
   * Validates materialization proof against chat revision and result hash.
   * Rejects conflicts where chat revision has diverged or resultHash does not match.
   */
  public verifyMaterialization(
    job: JobMetadata,
    proof: MaterializationProof
  ): { valid: boolean; reason?: string } {
    if (!job.result?.resultHash) {
      return { valid: false, reason: "Job does not contain a committed resultHash" };
    }

    if (proof.resultHash && proof.resultHash !== job.result.resultHash) {
      return {
        valid: false,
        reason: `ResultHashMismatch: Proof hash '${proof.resultHash}' != job hash '${job.result.resultHash}'`
      };
    }

    if (proof.chatRevision < job.generation.expectedChatRevision) {
      return {
        valid: false,
        reason: `ChatRevisionStale: Materialized revision '${proof.chatRevision}' < expected '${job.generation.expectedChatRevision}'`
      };
    }

    return { valid: true };
  }
}
