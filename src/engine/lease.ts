import { randomUUID } from "crypto";
import { JobMetadata, DeliveryLease } from "../contract/types.js";
import { transitionJob } from "./stateMachine.js";

export class LeaseAcquisitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseAcquisitionConflictError";
  }
}

export class FencingTokenStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencingTokenStaleError";
  }
}

export class LeaseExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseExpiredError";
  }
}

export class InvalidLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLeaseStateError";
  }
}

export class JobAlreadyCompletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobAlreadyCompletedError";
  }
}

export class DeliveryLeaseManager {
  /**
   * Acquires a delivery lease on a succeeded job.
   * If the lease is acquired successfully, increments the fencingToken and transitions the job to 'finalizing'.
   */
  public static acquireLease(
    job: JobMetadata,
    clientId: string,
    durationMs = 30000
  ): { updatedJob: JobMetadata; lease: DeliveryLease } {
    const { state } = job.recovery;

    if (state === "completed") {
      throw new JobAlreadyCompletedError(`Cannot acquire lease on completed job '${job.identity.clientJobId}'`);
    }

    const now = new Date();
    const isLeaseActive =
      job.delivery.deliveryState === "leased" &&
      job.delivery.leaseExpiresAt &&
      new Date(job.delivery.leaseExpiresAt) > now;

    if (isLeaseActive) {
      if (job.delivery.leaseOwner !== clientId) {
        throw new LeaseAcquisitionConflictError(
          `Conflict: Lease on job '${job.identity.clientJobId}' is already held by client '${job.delivery.leaseOwner}'`
        );
      } else {
        // Same client renewing active lease. Keep same fencingToken but extend expiration.
        const expiresAt = new Date(Date.now() + durationMs).toISOString();
        const updatedJob: JobMetadata = {
          ...job,
          delivery: {
            ...job.delivery,
            leaseExpiresAt: expiresAt
          },
          audit: {
            ...job.audit,
            updatedAt: now.toISOString()
          }
        };

        const lease: DeliveryLease = {
          leaseId: job.delivery.leaseId!,
          ownerClientId: clientId,
          fencingToken: job.delivery.fencingToken.toString(),
          expiresAt
        };

        return { updatedJob, lease };
      }
    }

    // Either undelivered or lease has expired. Increment fencing token and issue a new lease.
    const nextFencingToken = job.delivery.fencingToken + 1n;
    const leaseId = randomUUID();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();

    const deliveryUpdates = {
      deliveryState: "leased" as const,
      leaseOwner: clientId,
      leaseId,
      fencingToken: nextFencingToken,
      leaseExpiresAt: expiresAt
    };

    // Transition state from succeeded -> finalizing.
    // If it is already in finalizing or running/succeeded, we transition.
    // Notice that if transition fails (invalid transition from current state), it throws.
    // We only acquire delivery lease on succeeded state (or finalizing if lease expired).
    const targetState = "finalizing";
    const updatedJob = transitionJob(job, targetState, {
      delivery: deliveryUpdates
    });

    const lease: DeliveryLease = {
      leaseId,
      ownerClientId: clientId,
      fencingToken: nextFencingToken.toString(),
      expiresAt
    };

    return { updatedJob, lease };
  }

  /**
   * Renews an existing delivery lease.
   * Fails with FencingTokenStaleError if the provided fencingToken or leaseId is no longer the active one.
   */
  public static renewLease(
    job: JobMetadata,
    leaseId: string,
    fencingToken: bigint,
    durationMs = 30000
  ): { updatedJob: JobMetadata; lease: DeliveryLease } {
    if (job.delivery.deliveryState !== "leased") {
      throw new FencingTokenStaleError("Lease renewal rejected: No active lease exists");
    }

    if (job.delivery.leaseId !== leaseId || job.delivery.fencingToken !== fencingToken) {
      throw new FencingTokenStaleError("Lease renewal rejected: Fencing token or lease ID is stale");
    }

    const now = new Date();
    if (!job.delivery.leaseExpiresAt || new Date(job.delivery.leaseExpiresAt) <= now) {
      throw new LeaseExpiredError("Lease renewal rejected: lease has expired");
    }

    const expiresAt = new Date(now.getTime() + durationMs).toISOString();

    const updatedJob: JobMetadata = {
      ...job,
      delivery: {
        ...job.delivery,
        leaseExpiresAt: expiresAt
      },
      audit: {
        ...job.audit,
        updatedAt: now.toISOString()
      }
    };

    const lease: DeliveryLease = {
      leaseId,
      ownerClientId: job.delivery.leaseOwner!,
      fencingToken: fencingToken.toString(),
      expiresAt
    };

    return { updatedJob, lease };
  }

  /**
   * Finalizes a job that is in `finalizing` with a live matching lease.
   * Requires leaseId, fencing token, owner, unexpired lease, and finalizing state.
   */
  public static finalizeWithFencing(
    job: JobMetadata,
    leaseId: string,
    fencingToken: bigint,
    ownerClientId: string,
    materializationProof: { messageId: string; chatRevision: number; persistedAt: string },
    now = new Date()
  ): JobMetadata {
    if (job.recovery.state === "completed") {
      return job;
    }

    if (job.recovery.state !== "finalizing" || job.delivery.deliveryState !== "leased") {
      throw new InvalidLeaseStateError(
        `Finalization rejected: job must be in finalizing/leased state (state=${job.recovery.state}, delivery=${job.delivery.deliveryState})`
      );
    }

    if (job.delivery.leaseId !== leaseId || job.delivery.fencingToken !== fencingToken) {
      throw new FencingTokenStaleError(
        `Finalization rejected: Stale leaseId or fencing token (provided leaseId=${leaseId} token=${fencingToken}, active leaseId=${job.delivery.leaseId} token=${job.delivery.fencingToken})`
      );
    }

    if (job.delivery.leaseOwner !== ownerClientId) {
      throw new FencingTokenStaleError(
        `Finalization rejected: lease owner mismatch (provided: ${ownerClientId}, active: ${job.delivery.leaseOwner})`
      );
    }

    if (!job.delivery.leaseExpiresAt || new Date(job.delivery.leaseExpiresAt) <= now) {
      throw new LeaseExpiredError("Finalization rejected: lease has expired");
    }

    const updatedJob = transitionJob(job, "completed", {
      delivery: {
        ...job.delivery,
        deliveryState: "delivered"
      },
      result: {
        ...job.result,
        resultRef: `proof://${materializationProof.messageId}`
      }
    });

    return updatedJob;
  }
}
