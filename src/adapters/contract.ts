import { BackgroundCapabilities, CreateBackgroundJobRequest, JobMetadata } from "../contract/index.js";

export interface BackgroundAdapter {
  target: "vanilla" | "haejeok" | "pocket";
  getCapabilities(): BackgroundCapabilities;
  mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): any;
  handleFinalization(job: JobMetadata, proof: any): Promise<void>;
}
