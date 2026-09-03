export interface BackgroundFeatureFlags {
  tabCloseDurable: boolean;
  restartRecovery: boolean;
  eventReplay: boolean;
  mainJobs: boolean;
  auxJobs: boolean;
  toolWorkflows: boolean;
  deliveryLease: boolean;
  durableFinalization: boolean;
  serverProviders: boolean;
  browserProviderPersistence: boolean;
}

export interface BackgroundCapabilities {
  contractVersion: number;
  /**
   * Currently implemented features for this adapter/target.
   * Future roadmap flags live in TARGET_ADAPTER_GOALS and must not be copied here.
   */
  features: BackgroundFeatureFlags;
  pipelineVersion: string;
  adapter: {
    target: "vanilla" | "haejeok" | "pocket";
    version: string;
  };
}
