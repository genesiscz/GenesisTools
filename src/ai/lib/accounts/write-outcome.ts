import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type ApplyLoginOutcomeResult, applyLoginOutcome } from "@genesiscz/utils/ai/config/account-ops";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountIdentity, LoginOutcome } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { identityMismatch } from "@genesiscz/utils/ai/providers/identity-guard";
import { logger, out } from "@genesiscz/utils/logger";
import { expandPath } from "@genesiscz/utils/paths";
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

/**
 * Refuse to point a second account at a credential file another account already
 * owns.
 *
 * `applyIdentityPolicy` above compares only the account being written, so it has
 * nothing to say about the OTHER account whose file this login just replaced:
 * logging `personal` into the home `work` reads left both entries serving one
 * grant, and neither of them said so (PR #360 review t1). On a TTY this is a
 * confirmation, because two entries on one file is a legitimate (if unusual)
 * setup; in a pipe it is a refusal.
 */
export async function applyAuthFileOwnershipPolicy(input: {
    accountName: string;
    /** Excludes the account being written by id when known, so a namesake is still a foreign owner. */
    accountId?: string;
    authFile?: string;
    interactive: boolean;
}): Promise<IdentityDecision> {
    if (!input.authFile) {
        return { ok: true };
    }

    const store = await AiConfigStore.load();
    // Compared RESOLVED, not raw: the login boundary normalizes what it is given,
    // but an account stored before that (or edited by hand with a `~/` or a
    // relative spelling) names the same file in a different string, and a raw
    // comparison let that spelling walk past the check (PR #359 review t9).
    const incoming = expandPath(input.authFile);
    const owner = store
        .accounts()
        .find(
            (entry) =>
                (input.accountId === undefined ? entry.name !== input.accountName : entry.id !== input.accountId) &&
                entry.credentials.authFile !== undefined &&
                expandPath(entry.credentials.authFile) === incoming
        );

    if (!owner) {
        return { ok: true };
    }

    const reason = `${input.authFile} is already the credential file of account "${owner.name}".`;
    out.printlnErr(pc.yellow(`⚠ ${reason}`));

    if (!input.interactive) {
        return {
            ok: false,
            reason: `${reason} Refusing to bind it to "${input.accountName}" as well without a terminal to confirm on.`,
        };
    }

    const proceed = await p.confirm({ message: `Point "${input.accountName}" at it too?`, initialValue: false });

    if (p.isCancel(proceed) || !proceed) {
        return { ok: false, reason: "Cancelled — nothing written." };
    }

    return { ok: true };
}

/**
 * A name the flow only GUESSED never replaces another provider's account.
 *
 * `login` without `--name` takes the provider identity's local part, and that
 * lookup treated a hit as permission to overwrite: an API-key account `work`
 * met a codex login for work@example.com, passed the identity guard (an API
 * key carries no uuid to contradict) and `applyLoginOutcome` switched its
 * provider and deleted its vault secrets (PR #359 review t5). An explicit name
 * or a prompted one is the user's decision; a suggested one is not.
 */
export async function applySuggestedNamePolicy(input: {
    accountName: string;
    account?: AccountEntry;
    provider: string;
    interactive: boolean;
}): Promise<IdentityDecision> {
    if (!input.account || input.account.provider === input.provider) {
        return { ok: true };
    }

    const stored = providerAliasOf(input.account.provider);
    const reason =
        `"${input.accountName}" is already a ${stored} account, and this ${providerAliasOf(input.provider)} ` +
        "login only guessed that name.";

    out.printlnErr(pc.yellow(`⚠ ${reason}`));

    if (!input.interactive) {
        return { ok: false, reason: `${reason} Refusing to replace its credentials; pass --name to choose.` };
    }

    const proceed = await p.confirm({
        message: `Replace the ${stored} credentials of "${input.accountName}" with this login?`,
        initialValue: false,
    });

    if (p.isCancel(proceed) || !proceed) {
        return { ok: false, reason: "Cancelled — nothing written. Re-run with --name <other> to keep both." };
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
    /** The name was suggested by the flow, not typed or confirmed by the user. */
    autoNamed?: boolean;
    apps?: string[];
    defaultForApps?: string[];
}

/**
 * A rollback that fails must not turn a clean refusal into a crash: the config
 * was NOT written either way, so the account is still consistent. Say what was
 * left behind rather than swallowing it.
 */
async function rollbackOutcome(outcome: LoginOutcome): Promise<void> {
    if (!outcome.rollback) {
        return;
    }

    try {
        await outcome.rollback();
        logger.info({ provider: outcome.provider }, "identity refused: rolled back the flow's on-disk write");
    } catch (err) {
        logger.warn({ err, provider: outcome.provider }, "identity refused but the rollback failed");
        out.printlnErr(
            pc.yellow("  Could not undo the credential file this login wrote — check it before using the account.")
        );
    }
}

/** Returns null when the identity policy refused; the caller prints and exits 1. */
export async function writeLoginOutcome(input: WriteLoginOutcomeInput): Promise<ApplyLoginOutcomeResult | null> {
    if (input.autoNamed) {
        const named = await applySuggestedNamePolicy({
            accountName: input.name,
            account: input.account,
            provider: input.outcome.provider,
            interactive: input.interactive,
        });

        if (!named.ok) {
            out.printlnErr(pc.red(named.reason));
            await rollbackOutcome(input.outcome);
            return null;
        }
    }

    const decision = await applyIdentityPolicy({
        accountName: input.name,
        stored: input.storedIdentity ?? storedIdentityOf(input.account),
        incoming: input.outcome.identity,
        interactive: input.interactive,
    });

    if (!decision.ok) {
        out.printlnErr(pc.red(decision.reason));
        // The flow may already have written a vendor file (codex's `auth.json`).
        // Refusing the CONFIG write while leaving that file replaced is the worst
        // of both: the account still names the old identity while the resolver
        // reads the new credential (PR #360 review t17).
        await rollbackOutcome(input.outcome);
        return null;
    }

    const ownership = await applyAuthFileOwnershipPolicy({
        accountName: input.name,
        accountId: input.account?.id,
        authFile: input.outcome.credentials.authFile,
        interactive: input.interactive,
    });

    if (!ownership.ok) {
        out.printlnErr(pc.red(ownership.reason));
        await rollbackOutcome(input.outcome);
        return null;
    }

    // By id whenever the caller resolved one: the secondary flow and a re-login
    // both start from an existing entry, and a name alone picks the first
    // namesake across every provider (PR #360 review t4).
    return applyLoginOutcome({
        name: input.name,
        id: input.account?.id,
        outcome: input.outcome,
        apps: input.apps,
        defaultForApps: input.defaultForApps,
    });
}
