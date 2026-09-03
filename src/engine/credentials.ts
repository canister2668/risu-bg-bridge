import {
  CredentialResolver,
  CredentialResolutionResult,
  ResolvedCredential,
  BlockedCredential
} from "../contract/types.js";

/**
 * In-memory reference credential resolver.
 * Maps credential references (e.g. "provider-account://openai/default")
 * to credentials without ever storing secret tokens in job metadata or event journals.
 */
export class InMemoryCredentialResolver implements CredentialResolver {
  private credentials = new Map<string, {
    epoch: string;
    secret: Record<string, any>;
    blocked?: boolean;
    blockReason?: string;
  }>();

  public registerCredential(
    ref: string,
    secret: Record<string, any>,
    epoch = "1",
    blocked = false,
    blockReason?: string
  ): void {
    this.credentials.set(ref, { epoch, secret, blocked, blockReason });
  }

  public revokeCredential(ref: string, reason = "Credential revoked by user"): void {
    const cred = this.credentials.get(ref);
    if (cred) {
      cred.blocked = true;
      cred.blockReason = reason;
    }
  }

  public rotateCredential(ref: string, newSecret: Record<string, any>, newEpoch: string): void {
    const cred = this.credentials.get(ref);
    if (cred) {
      cred.secret = newSecret;
      cred.epoch = newEpoch;
      cred.blocked = false;
      cred.blockReason = undefined;
    } else {
      this.registerCredential(ref, newSecret, newEpoch);
    }
  }

  public async resolveCredential(ref: string, expectedEpoch?: string): Promise<CredentialResolutionResult> {
    const cred = this.credentials.get(ref);

    if (!cred) {
      return {
        status: "failed_credential",
        credentialRef: ref,
        reason: `CredentialNotFound: No credential found for reference '${ref}'`
      };
    }

    if (cred.blocked) {
      return {
        status: "blocked_credential",
        credentialRef: ref,
        reason: cred.blockReason || `CredentialBlocked: Credential '${ref}' is disabled`
      };
    }

    if (expectedEpoch !== undefined && cred.epoch !== expectedEpoch) {
      return {
        status: "blocked_credential",
        credentialRef: ref,
        reason: `CredentialEpochMismatch: Expected epoch '${expectedEpoch}', current is '${cred.epoch}'. Stale job cannot run with rotated credential without operator re-approval.`
      };
    }

    return {
      status: "resolved",
      credentialRef: ref,
      credentialEpoch: cred.epoch,
      secret: { ...cred.secret }
    };
  }
}
