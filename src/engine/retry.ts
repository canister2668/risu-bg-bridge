import { JobMetadata } from "../contract/types.js";

export type ErrorType =
  | "NETWORK_TIMEOUT"
  | "SERVER_503"
  | "CLIENT_400"
  | "SSE_HALF_CLOSED"
  | "CRASH";

export interface RetryEvidence {
  /**
   * Whether the provider request is known to have been sent.
   * `unknown` (default) means send success was not confirmed.
   */
  requestSent?: boolean | "unknown";
  /** Provider returned a definitive rejection (4xx, auth, policy). */
  definitiveRejection?: boolean;
}

export interface RetryEvaluation {
  action: "retry" | "fail" | "ambiguous";
  nextRetryAt?: string;
  reason: string;
}

export class RetryPolicyEngine {
  /**
   * Evaluates retry vs fail vs ambiguous using retry policy and send evidence.
   * Non-idempotent providers cannot retry when it is unclear whether the
   * request reached the provider.
   */
  public static evaluate(
    job: JobMetadata,
    errorType: ErrorType,
    now = new Date(),
    evidence: RetryEvidence = {}
  ): RetryEvaluation {
    const { attempt } = job.execution;
    const { retryPolicy } = job.recovery;
    const { maxAttempts, initialDelayMs, backoffFactor, idempotencySupported } = retryPolicy;
    const requestSent = evidence.requestSent ?? "unknown";
    const sendUncertain = requestSent !== false;

    if (errorType === "CLIENT_400" || evidence.definitiveRejection) {
      return {
        action: "fail",
        reason: "ClientError: Invalid request parameters, configuration, or credentials. Retry disabled."
      };
    }

    if (!idempotencySupported && sendUncertain) {
      return {
        action: "ambiguous",
        reason: `AmbiguousExecution: Non-idempotent provider and send is uncertain (requestSent=${String(requestSent)}, ${errorType}).`
      };
    }

    if (attempt >= maxAttempts) {
      return {
        action: "fail",
        reason: `MaxAttemptsExceeded: Exceeded maximum retry attempts (${attempt}/${maxAttempts}).`
      };
    }

    const delayMs = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
    const nextRetryAt = new Date(now.getTime() + delayMs).toISOString();

    return {
      action: "retry",
      nextRetryAt,
      reason: `RetryableFailure: Error '${errorType}' encountered on attempt ${attempt} with requestSent=${String(requestSent)}. Scheduling retry in ${delayMs}ms.`
    };
  }
}
