export type JobKind = "main" | "aux" | "tool-workflow";

export type JobState =
  | "reserved"
  | "queued"
  | "running"
  | "awaiting_tool"
  | "ambiguous"
  | "failed"
  | "cancelled"
  | "succeeded"
  | "finalizing"
  | "completed";

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  idempotencySupported: boolean;
}

export interface CredentialReference {
  credentialRef: string; // e.g. "provider-account://openai/default"
  credentialEpoch?: string; // rotation generation/identity, never secret
}

export type CredentialResolutionStatus =
  | "resolved"
  | "blocked_credential"
  | "failed_credential";

export interface ResolvedCredential {
  status: "resolved";
  credentialRef: string;
  credentialEpoch?: string;
  secret: Record<string, any>;
  expiresAt?: string;
}

export interface BlockedCredential {
  status: "blocked_credential" | "failed_credential";
  credentialRef: string;
  reason: string;
}

export type CredentialResolutionResult = ResolvedCredential | BlockedCredential;

export interface CredentialResolver {
  resolveCredential(ref: string, expectedEpoch?: string): Promise<CredentialResolutionResult>;
}

export interface JobMetadata {
  /** Monotonic compare-and-set version owned by the job registry. */
  recordVersion: number;
  identity: {
    principalId: string;
    clientJobId: string;
    requestFingerprint: string;
    serverInternalId?: string;
  };
  kind: JobKind;
  execution: {
    providerRef: string;
    modelRef: string;
    credentialRef: string; // reference, never secret plaintext
    credentialEpoch?: string; // non-secret credential generation/rotation identity
    requestEnvelopeRef: string;
    attempt: number;
    executionEpoch: number;
  };
  generation: {
    chatId: string;
    characterId: string;
    generationId: string;
    mode: string;
    expectedChatRevision: number;
  };
  versioning: {
    contractVersion: number;
    jobSchemaVersion: number;
    pipelineVersion: string;
    pluginVersion: string;
    adapterVersion: string;
  };
  result?: {
    resultRef?: string;
    resultHash?: string;
    terminalSignal?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    finishReason?: string;
  };
  recovery: {
    state: JobState;
    previousState?: JobState;
    retryPolicy: RetryPolicy;
    ambiguousReason?: string;
    nextRetryAt?: string; // ISO timestamp
  };
  delivery: {
    deliveryState: "undelivered" | "leased" | "delivered";
    leaseOwner?: string;
    leaseId?: string;
    fencingToken: bigint;
    leaseExpiresAt?: string; // ISO timestamp
  };
  audit: {
    createdAt: string; // ISO timestamp
    startedAt?: string;
    updatedAt: string;
    finishedAt?: string;
    finalizedAt?: string;
  };
}

export interface CreateBackgroundJobRequest {
  clientJobId: string;
  kind: JobKind;
  providerRef: string;
  modelRef: string;
  credentialRef: string;
  credentialEpoch?: string;
  payload: Record<string, any>; // Containing prompts, generation options, excluding raw secrets
  generation: {
    chatId: string;
    characterId: string;
    generationId: string;
    mode: string;
    expectedChatRevision: number;
  };
  versioning: {
    contractVersion: number;
    pipelineVersion: string;
    pluginVersion: string;
  };
  retryPolicy?: Partial<RetryPolicy>;
  consumerGroups?: string[]; // Optional consumer groups for aux jobs
}

export interface JobSnapshot {
  jobId: string;
  state: JobState;
  kind: JobKind;
  fingerprint: string;
  attempt: number;
  generationId: string;
  resultHash?: string;
  error?: string;
  updatedAt: string;
  deliveryState: "undelivered" | "leased" | "delivered";
  leaseExpiresAt?: string;
}

export interface JobResult {
  jobId: string;
  resultHash: string;
  payload: any;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export interface JobListFilter {
  state?: JobState;
  kind?: JobKind;
  generationId?: string;
  chatId?: string;
  principalId?: string;
  unconsumedBy?: string; // Filter for aux jobs not yet ACKed by consumerId
}

export interface MaterializationProof {
  messageId: string;
  chatRevision: number;
  persistedAt: string;
  resultHash?: string;
}

export interface FinalizeRequest {
  leaseId: string;
  fencingToken: string; // bigint representation as string for transport safety
  materializationProof: MaterializationProof;
}

export interface FinalizeResult {
  jobId: string;
  status: "completed" | "failed";
  error?: string;
}

export interface JobEvent {
  jobId: string;
  seq: number; // monotonic per job, starting from 1
  eventId: string;
  type:
    | "state"
    | "provider_chunk"
    | "tool_call"
    | "tool_result"
    | "result_ready"
    | "finalization_stage"
    | "error";
  createdAt: string; // ISO timestamp
  payloadRef?: string;
  payload?: any;
}

export interface DeliveryLease {
  leaseId: string;
  ownerClientId: string;
  fencingToken: string; // bigint as string for JSON transport safety
  expiresAt: string; // ISO timestamp
}

// Tool Workflow types
export type ToolReplayPolicy = "safe" | "idempotent" | "confirm" | "never";
export type ToolExecutorType = "server" | "client" | "approval";
export type ToolCallState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked_confirm"
  | "cancelled";

export interface ToolCallCheckpoint {
  jobId: string;
  toolCallId: string;
  toolName: string;
  argsHash: string;
  args: Record<string, any>;
  executorType: ToolExecutorType;
  replayPolicy: ToolReplayPolicy;
  state: ToolCallState;
  resultRef?: string;
  resultPayload?: any;
  idempotencyKey?: string;
  approvalGranted?: boolean;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
}

// Resumable Finalization & Stage Ledger types
export interface DurableGenerationContext {
  chatId: string;
  characterId: string;
  generationId: string;
  requestMode: string;
  expectedChatRevision: number;
  processingProfileSnapshot?: Record<string, any>;
  triggerReplacerVersions?: Record<string, string>;
  modelPresetRef?: string;
  pipelineVersion: string;
}

export type FinalizationStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface FinalizationStageLedgerEntry {
  jobId: string;
  generationId: string;
  stageId: string;
  stageVersion: number;
  inputHash: string;
  status: FinalizationStageStatus;
  attempt: number;
  outputHash?: string;
  outputPayload?: any;
  error?: string;
  completedAt?: string;
}

export interface AuxConsumerAck {
  jobId: string;
  consumerId: string;
  consumerGroup?: string;
  resultHash: string;
  ackedAt: string;
}
