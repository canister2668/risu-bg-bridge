import {
  JobMetadata,
  JobEvent,
  JobResult,
  ToolCallCheckpoint,
  FinalizationStageLedgerEntry,
  AuxConsumerAck,
  JobListFilter
} from "../contract/types.js";

export interface PutJobResult {
  job: JobMetadata;
  isNew: boolean;
}

export interface BgStorageEngine {
  /** Initialize tables, schemas, indexes */
  init(): Promise<void>;
  /** Close database connections / resources */
  close(): Promise<void>;

  // --- Job CRUD & CAS ---
  putJob(principalId: string, job: JobMetadata): Promise<PutJobResult>;
  getJob(principalId: string, clientJobId: string): Promise<JobMetadata | null>;
  getJobById(clientJobId: string): Promise<JobMetadata | null>;
  updateJobCas(
    principalId: string,
    clientJobId: string,
    expectedRecordVersion: number,
    updatedJob: JobMetadata
  ): Promise<JobMetadata>;
  listJobs(principalId: string, filter?: JobListFilter): Promise<JobMetadata[]>;
  listActiveJobs(): Promise<JobMetadata[]>;

  // --- Request Envelopes ---
  saveRequestEnvelope(envelopeRef: string, payload: any): Promise<void>;
  getRequestEnvelope(envelopeRef: string): Promise<any | null>;

  // --- Typed Event Journal ---
  appendEvent(event: JobEvent): Promise<JobEvent>;
  getEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>;

  // --- Results ---
  saveResult(result: JobResult): Promise<void>;
  getResult(jobId: string): Promise<JobResult | null>;

  // --- Tool Checkpoints ---
  saveToolCheckpoint(checkpoint: ToolCallCheckpoint): Promise<void>;
  getToolCheckpoint(jobId: string, toolCallId: string): Promise<ToolCallCheckpoint | null>;
  listToolCheckpoints(jobId: string): Promise<ToolCallCheckpoint[]>;

  // --- Finalization Stage Ledger ---
  saveStageEntry(entry: FinalizationStageLedgerEntry): Promise<void>;
  getStageEntry(
    jobId: string,
    generationId: string,
    stageId: string,
    stageVersion: number
  ): Promise<FinalizationStageLedgerEntry | null>;
  listStageEntries(jobId: string, generationId: string): Promise<FinalizationStageLedgerEntry[]>;

  // --- Aux Consumer ACKs ---
  recordAuxAck(ack: AuxConsumerAck): Promise<void>;
  getAuxAcks(jobId: string): Promise<AuxConsumerAck[]>;
  isAuxAckedBy(jobId: string, consumerId: string): Promise<boolean>;
}
