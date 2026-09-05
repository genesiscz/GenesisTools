import type { AccountIdentity, LoginOutcome } from "./account-features";

/**
 * The fingerprint a login proved, in the shape that survives the write.
 *
 * `LoginOutcome.identity` names the account and is then dropped; only
 * `accountFields` reaches the stored entry (`account-ops.ts` `applyAccountFields`).
 * A flow that returns an identity without copying it here stores no uuid, so
 * `identityMismatch` has nothing to contradict on the next login and a stranger's
 * credential overwrites the account in silence.
 *
 * Every field is conditional on purpose: an absent uuid must stay absent rather
 * than be written as `undefined`, because "unprovable" and "contradicted" are
 * different answers to the guard.
 */
export function accountFieldsFrom(identity: AccountIdentity): LoginOutcome["accountFields"] {
    return {
        ...(identity.accountUuid ? { accountUuid: identity.accountUuid } : {}),
        ...(identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {}),
        ...(identity.plan ? { label: identity.plan } : {}),
    };
}
