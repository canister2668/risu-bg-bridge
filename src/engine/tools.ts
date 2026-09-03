import { createHash } from "node:crypto";
import {
  ToolCallCheckpoint,
  ToolReplayPolicy,
  ToolExecutorType,
  ToolCallState
} from "../contract/types.js";
import { BgStorageEngine } from "../storage/interface.js";

export function calculateArgsHash(args: Record<string, any>): string {
  const serialized = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(serialized).digest("hex");
}

export type ServerToolHandler = (
  toolName: string,
  args: Record<string, any>,
  idempotencyKey?: string
) => Promise<any>;

export interface ToolExecutionEvaluation {
  action: "execute" | "replay_existing" | "await_client" | "await_approval" | "blocked";
  reason: string;
}

/**
 * Tool workflow orchestrator managing checkpointing, replay policies,
 * executor routing (server/client/approval), and crash recovery.
 */
export class ToolExecutionEngine {
  private serverHandlers = new Map<string, ServerToolHandler>();

  constructor(private storage: BgStorageEngine) {}

  public registerServerTool(toolName: string, handler: ServerToolHandler): void {
    this.serverHandlers.set(toolName, handler);
  }

  /**
   * Evaluates how to handle a tool call based on replay policy and existing checkpoint.
   */
  public evaluateToolCall(
    checkpoint: ToolCallCheckpoint | null,
    replayPolicy: ToolReplayPolicy,
    executorType: ToolExecutorType
  ): ToolExecutionEvaluation {
    if (!checkpoint) {
      if (executorType === "client") {
        return { action: "await_client", reason: "Client executor: awaiting client reconnection." };
      }
      if (executorType === "approval") {
        return { action: "await_approval", reason: "Approval executor: awaiting explicit user approval." };
      }
      return { action: "execute", reason: "New server tool call ready for execution." };
    }

    // Existing checkpoint
    if (checkpoint.state === "succeeded") {
      return { action: "replay_existing", reason: "Tool already completed successfully; replaying cached result." };
    }

    if (checkpoint.state === "blocked_confirm") {
      return { action: "blocked", reason: "Tool requires manual operator confirmation before retry." };
    }

    if (executorType === "client") {
      return { action: "await_client", reason: "Client executor: awaiting client response." };
    }

    if (executorType === "approval" && !checkpoint.approvalGranted) {
      return { action: "await_approval", reason: "Approval executor: awaiting user approval." };
    }

    // Handling recovery after failure / crash:
    switch (replayPolicy) {
      case "safe":
        return { action: "execute", reason: "Replay policy 'safe': auto-reexecuting tool." };
      case "idempotent":
        if (checkpoint.idempotencyKey) {
          return { action: "execute", reason: "Replay policy 'idempotent': re-executing with idempotencyKey." };
        }
        return { action: "blocked", reason: "Replay policy 'idempotent' without idempotencyKey: blocked." };
      case "confirm":
        return { action: "blocked", reason: "Replay policy 'confirm': execution uncertain, operator confirmation required." };
      case "never":
        return { action: "blocked", reason: "Replay policy 'never': re-execution strictly forbidden." };
      default:
        return { action: "blocked", reason: `Unknown replay policy '${replayPolicy}'.` };
    }
  }

  /**
   * Records or updates a tool checkpoint in storage.
   */
  public async checkpointTool(
    jobId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, any>,
    executorType: ToolExecutorType,
    replayPolicy: ToolReplayPolicy,
    idempotencyKey?: string
  ): Promise<ToolCallCheckpoint> {
    const existing = await this.storage.getToolCheckpoint(jobId, toolCallId);
    if (existing) {
      return existing;
    }

    const checkpoint: ToolCallCheckpoint = {
      jobId,
      toolCallId,
      toolName,
      argsHash: calculateArgsHash(args),
      args,
      executorType,
      replayPolicy,
      state: executorType === "approval" ? "blocked_confirm" : "pending",
      idempotencyKey,
      approvalGranted: false,
      attempt: 1,
      startedAt: new Date().toISOString()
    };

    await this.storage.saveToolCheckpoint(checkpoint);
    return checkpoint;
  }

  /**
   * Executes a server tool call with crash safety and checkpointing.
   */
  public async executeServerTool(
    jobId: string,
    toolCallId: string
  ): Promise<{ checkpoint: ToolCallCheckpoint; result: any }> {
    const checkpoint = await this.storage.getToolCheckpoint(jobId, toolCallId);
    if (!checkpoint) {
      throw new Error(`ToolCheckpointNotFound: No checkpoint found for tool '${toolCallId}' on job '${jobId}'`);
    }

    const evalResult = this.evaluateToolCall(checkpoint, checkpoint.replayPolicy, checkpoint.executorType);

    if (evalResult.action === "replay_existing") {
      return { checkpoint, result: checkpoint.resultPayload };
    }

    if (evalResult.action === "blocked") {
      checkpoint.state = "blocked_confirm";
      await this.storage.saveToolCheckpoint(checkpoint);
      throw new Error(`ToolExecutionBlocked: ${evalResult.reason}`);
    }

    const handler = this.serverHandlers.get(checkpoint.toolName);
    if (!handler) {
      checkpoint.state = "failed";
      await this.storage.saveToolCheckpoint(checkpoint);
      throw new Error(`ToolHandlerNotFound: No server handler registered for tool '${checkpoint.toolName}'`);
    }

    checkpoint.state = "running";
    await this.storage.saveToolCheckpoint(checkpoint);

    try {
      const result = await handler(checkpoint.toolName, checkpoint.args, checkpoint.idempotencyKey);
      checkpoint.state = "succeeded";
      checkpoint.resultPayload = result;
      checkpoint.completedAt = new Date().toISOString();
      await this.storage.saveToolCheckpoint(checkpoint);
      return { checkpoint, result };
    } catch (err: any) {
      checkpoint.attempt += 1;
      if (checkpoint.replayPolicy === "confirm" || checkpoint.replayPolicy === "never") {
        checkpoint.state = "blocked_confirm";
      } else {
        checkpoint.state = "failed";
      }
      await this.storage.saveToolCheckpoint(checkpoint);
      throw err;
    }
  }

  /**
   * Records a tool result supplied by a client or user approval.
   */
  public async recordToolResult(
    jobId: string,
    toolCallId: string,
    resultPayload: any,
    success = true
  ): Promise<ToolCallCheckpoint> {
    const checkpoint = await this.storage.getToolCheckpoint(jobId, toolCallId);
    if (!checkpoint) {
      throw new Error(`ToolCheckpointNotFound: No checkpoint for '${toolCallId}'`);
    }

    checkpoint.state = success ? "succeeded" : "failed";
    checkpoint.resultPayload = resultPayload;
    checkpoint.completedAt = new Date().toISOString();
    await this.storage.saveToolCheckpoint(checkpoint);
    return checkpoint;
  }

  /**
   * Approves a blocked or approval-required tool call.
   */
  public async approveTool(jobId: string, toolCallId: string): Promise<ToolCallCheckpoint> {
    const checkpoint = await this.storage.getToolCheckpoint(jobId, toolCallId);
    if (!checkpoint) {
      throw new Error(`ToolCheckpointNotFound: No checkpoint for '${toolCallId}'`);
    }

    checkpoint.approvalGranted = true;
    checkpoint.state = "pending";
    await this.storage.saveToolCheckpoint(checkpoint);
    return checkpoint;
  }
}
