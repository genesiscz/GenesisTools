import * as p from "@clack/prompts";
import { type ApplyLoginOutcomeResult, applyLoginOutcome } from "@genesiscz/utils/ai/config/account-ops";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountIdentity, LoginOutcome } from "@genesiscz/utils/ai/providers/account-features";
import { identityMismatch } from "@genesiscz/utils/ai/providers/identity-guard";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/**
 * The one place a login result becomes a config write.
 *
 * Only Anthropic can prove whose token it just received, so the policy is
 * written once here rather than per provider: a contradicted identity needs a
 * confirmation (TTY) or is refused (non-TTY), and a flow that proved nothing
 * writes but says so.
 */

export type IdentityDecision = { ok: true } | { ok: false; reason: string };

export interface IdentityPolicyInput {
    accountName: string;
    /** What the account already claims. Absent for a first login. */
    stored?: AccountIdentity;
    /** What the flow just proved. Absent when the provider proves nothing. */
    incoming?: AccountIdentity;
    interactive: boolean;
}

/** The fingerprint an existing account carries, secondary grant included. */
export function storedIdentityOf(account?: AccountEntry): AccountIdentity | undefined {
    if (!account) {
        return undefined;
    }

    const secondary = account.credentials.secondary;

    return {
        accountUuid: account.accountUuid ?? secondary?.accountUuid,
        organizationUuid: account.organizationUuid ?? secondary?.organizationUuid,
    };
}

export async function applyIdentityPolicy(input: IdentityPolicyInput): Promise<IdentityDecision> {
    const mismatched =
        identityMismatch({ storedUuid: input.stored?.accountUuid, incomingUuid: input.incoming?.accountUuid }) ||
        identityMismatch({
            storedUuid: input.stored?.organizationUuid,
            incomingUuid: input.incoming?.organizationUuid,
        });

    if (!mismatched) {
        // Rule 2 of the policy: a flow that returned no identity at all (grok's
        // external login, a codex token without claims) still writes, but the
        // user is told that nobody checked.
        if (!input.incoming?.accountUuid && !input.incoming?.organizationUuid) {
            // stderr: this is a notice, not the machine result, and `--json`
            // callers of `accounts discover --bind` parse stdout (review t2).
            out.printlnErr(
                pc.dim(`  Identity was not verified — this provider does not say whose credential this is.`)
            );
        }

        return { ok: true };
    }

    const reason =
        `This grant belongs to ${input.incoming?.email ?? "another identity"}, ` +
        `a DIFFERENT one than "${input.accountName}".`;

    out.printlnErr(pc.yellow(`⚠ ${reason}`));

    if (!input.interactive) {
        return {
            ok: false,
            reason: `${reason} Refusing to overwrite it without a terminal to confirm on.`,
        };
    }

    const proceed = await p.confirm({ message: "Save anyway?", initialValue: false });

    if (p.isCancel(proceed) || !proceed) {
        return { ok: false, reason: "Cancelled — nothing written." };
    }

    return { ok: true };
}

export interface WriteLoginOutcomeInput {
    name: string;
    outcome: LoginOutcome;
    interactive: boolean;
    /** The account being overwritten, when there is one. */
    account?: AccountEntry;
    /**
     * Comparand for the identity guard. Defaults to the account's own fingerprint;
     * `login-secondary` passes the SECONDARY grant's, because that is the key
     * future keychain rotations match on.
     */
    storedIdentity?: AccountIdentity;
    apps?: string[];
    defaultForApps?: string[];
}

/** Returns null when the identity policy refused; the caller prints and exits 1. */
export async function writeLoginOutcome(input: WriteLoginOutcomeInput): Promise<ApplyLoginOutcomeResult | null> {
    const decision = await applyIdentityPolicy({
        accountName: input.name,
        stored: input.storedIdentity ?? storedIdentityOf(input.account),
        incoming: input.outcome.identity,
        interactive: input.interactive,
    });

    if (!decision.ok) {
        out.printlnErr(pc.red(decision.reason));
        return null;
    }

    return applyLoginOutcome({
        name: input.name,
        outcome: input.outcome,
        apps: input.apps,
        defaultForApps: input.defaultForApps,
    });
}
