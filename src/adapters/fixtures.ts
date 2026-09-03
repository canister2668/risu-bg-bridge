import { BackgroundAdapter } from "./contract.js";
import { BackgroundCapabilities, CreateBackgroundJobRequest, JobMetadata } from "../contract/index.js";

export class VanillaBackgroundAdapter implements BackgroundAdapter {
  public readonly target = "vanilla" as const;

  public getCapabilities(): BackgroundCapabilities {
    return {
      contractVersion: 1,
      features: {
        tabCloseDurable: false, // Stock fallback runs in foreground only
        restartRecovery: false,
        eventReplay: false,
        mainJobs: false,
        auxJobs: false,
        toolWorkflows: false,
        deliveryLease: false,
        durableFinalization: false,
        serverProviders: false,
        browserProviderPersistence: false
      },
      pipelineVersion: "none",
      adapter: {
        target: "vanilla",
        version: "v2026.8.250"
      }
    };
  }

  public mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): any {
    throw new Error("MethodNotSupported: Vanilla stock fallback does not support server job creation");
  }

  public async handleFinalization(job: JobMetadata, proof: any): Promise<void> {
    throw new Error("MethodNotSupported: Vanilla stock fallback does not support durable finalization");
  }
}

/**
 * Roadmap flags for a future complete implementation.
 * These must not be copied into getCapabilities() until the adapter
 * actually implements the feature against upstream.
 */
export const TARGET_ADAPTER_GOALS = {
  haejeok: {
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
  pocket: {
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
  }
} as const;

export class HaejeokBackgroundAdapter implements BackgroundAdapter {
  public readonly target = "haejeok" as const;

  public getCapabilities(): BackgroundCapabilities {
    return {
      contractVersion: 1,
      features: {
        // Verified legacy Haejeok b6704 baseline: host PUT model-jobs for main generation.
        // restart/tool/lease/finalizer/serverProviders are not implemented.
        tabCloseDurable: true,
        restartRecovery: false,
        eventReplay: false,
        mainJobs: true,
        auxJobs: false,
        toolWorkflows: false,
        deliveryLease: false,
        durableFinalization: false,
        serverProviders: false,
        browserProviderPersistence: false
      },
      pipelineVersion: "risu-finalize/1",
      adapter: {
        target: "haejeok",
        version: "b6704+bg1"
      }
    };
  }

  public mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): any {
    // Mimic mapping to Haejeok modelJobs schema
    return {
      jobId: clientJobId,
      model: req.modelRef,
      prompt: req.payload.messages || [],
      context: {
        chatId: req.generation.chatId,
        generationId: req.generation.generationId
      },
      status: "queued"
    };
  }

  public async handleFinalization(job: JobMetadata, proof: any): Promise<void> {
    // Mimic the recovered result insertion into the chat generation pipeline in Haejeok b6704
    if (!job.result?.resultHash) {
      throw new Error("Cannot finalize: missing result hash");
    }
    // Success: simulate update
  }
}

export class PocketBackgroundAdapter implements BackgroundAdapter {
  public readonly target = "pocket" as const;

  public getCapabilities(): BackgroundCapabilities {
    return {
      contractVersion: 1,
      features: {
        // Locked Pocket v1.10.0: durable main/aux transport and raw journal replay exist.
        // restart/tool/lease/finalizer/serverProviders are not implemented.
        tabCloseDurable: true,
        restartRecovery: false,
        eventReplay: true,
        mainJobs: true,
        auxJobs: true,
        toolWorkflows: false,
        deliveryLease: false,
        durableFinalization: false,
        serverProviders: false,
        browserProviderPersistence: false
      },
      pipelineVersion: "pocket-send/1",
      adapter: {
        target: "pocket",
        version: "1.10.0-bgbridge"
      }
    };
  }

  public mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): any {
    // Mimic mapping to PocketRisu sqlite/pending_sends schema
    return {
      id: clientJobId,
      payload: JSON.stringify(req.payload),
      status: "pending_claim"
    };
  }

  public async handleFinalization(job: JobMetadata, proof: any): Promise<void> {
    // Mimic Pocket's claim execution mapping
  }
}
