import { BackgroundAdapter } from "./contract.js";
import {
  BackgroundCapabilities,
  CreateBackgroundJobRequest,
  JobMetadata,
  MaterializationProof
} from "../contract/index.js";
import { BgStorageEngine } from "../storage/interface.js";
import { ResumableFinalizer } from "../engine/finalization.js";

/**
 * Runtime-backed Durable Background Adapter.
 * Backed by the common BgStorageEngine, credential resolver, and resumable finalizer.
 * Accurately reports what is implemented by this engine.
 */
export class DurableEngineAdapter implements BackgroundAdapter {
  public readonly target: "vanilla" | "haejeok" | "pocket";
  private finalizer: ResumableFinalizer;

  constructor(
    target: "vanilla" | "haejeok" | "pocket",
    private storage: BgStorageEngine,
    private adapterVersion = "engine-v1.0.0"
  ) {
    this.target = target;
    this.finalizer = new ResumableFinalizer(storage);
  }

  public getCapabilities(): BackgroundCapabilities {
    return {
      contractVersion: 1,
      features: {
        tabCloseDurable: true,
        restartRecovery: true,
        eventReplay: true,
        mainJobs: true,
        auxJobs: true,
        toolWorkflows: true,
        deliveryLease: true,
        durableFinalization: true,
        serverProviders: true,
        browserProviderPersistence: false
      },
      pipelineVersion: "risu-finalize/1",
      adapter: {
        target: this.target,
        version: this.adapterVersion
      }
    };
  }

  public mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): any {
    return {
      clientJobId,
      kind: req.kind,
      providerRef: req.providerRef,
      modelRef: req.modelRef,
      credentialRef: req.credentialRef,
      generation: req.generation,
      payload: req.payload
    };
  }

  public async handleFinalization(job: JobMetadata, proof: MaterializationProof): Promise<void> {
    const verified = this.finalizer.verifyMaterialization(job, proof);
    if (!verified.valid) {
      throw new Error(`FinalizationError: ${verified.reason}`);
    }
  }
}
