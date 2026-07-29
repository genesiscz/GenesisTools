import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { resolveSecret } from "@genesiscz/utils/security";
import type { AccountEntry } from "../config/schema";
import { envKeyNames } from "../config/selectors";
import type { CredentialSpec } from "./plugin-types";

export type CredentialSource = "vault" | "literal" | "env" | "file";

export interface ResolvedCredential {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    authFile?: string;
    dataDir?: string;
    /** Where the primary credential came from, for `doctor` and for logs. */
    source: CredentialSource;
    /** Set when `source` is "env", so a user can see which variable was spent. */
    envKey?: string;
}

export class CredentialUnavailableError extends Error {
    constructor(
        readonly accountName: string,
        readonly providerId: string,
        detail: string
    ) {
        super(`No usable credential for account "${accountName}" (${providerId}): ${detail}`);
        this.name = "CredentialUnavailableError";
    }
}

/**
 * Repair instructions for the fields that are ACTUALLY missing.
 *
 * A plugin may require `accessToken`, `authFile` or `dataDir` instead of an API
 * key, and telling the user to store an `apiKey` in those cases is a command
 * that cannot help and, for a subscription account, points at the wrong
 * credential entirely.
 */
function fixHint(account: AccountEntry, spec: CredentialSpec, missing: readonly string[]): string {
    const hints = missing.map((field) => {
        if (field === "authFile" || field === "dataDir") {
            const flag = field === "authFile" ? "--auth-file" : "--data-dir";
            return `Set it with: tools ai config account edit ${account.name} ${flag} <path>`;
        }

        return `Store it with: tools ai config secret set ai/${account.id}/${field}`;
    });

    // Only an API key can come from the environment (`resolveCredential` consults
    // it for that field alone), so this alternative is offered only when that is
    // what is missing. Comma-joined, not prose: the string is pasted straight
    // into a shell, and `--use-env A or B` is not a command anyone can run.
    if (missing.includes("apiKey") && spec.envKeys.length > 0) {
        hints.push(
            `or allow the environment: tools ai config account edit ${account.name} --use-env ${spec.envKeys.join(",")}`
        );
    }

    return hints.join(", ");
}

/**
 * The ONE place a credential is resolved.
 *
 * Order is account first, environment second: the reverse of the old
 * `ProviderManager` behavior, where an ambient variable outranked a configured
 * account and you could not tell which key was actually being spent.
 *
 * The environment is consulted only when the account opts in through
 * `useEnvApiKey`, and only for variables the plugin declares. Every site that
 * resolved keys from the environment before is preserved by seeding those
 * accounts with the opt-in (see the grandfather list), so this tightens
 * visibility without removing capability.
 */
export async function resolveCredential(account: AccountEntry, spec: CredentialSpec): Promise<ResolvedCredential> {
    const resolved: ResolvedCredential = { source: "literal" };

    for (const field of spec.fields) {
        if (field === "authFile" || field === "dataDir") {
            const value = account.credentials[field];
            if (value) {
                resolved[field] = value;
                resolved.source = "file";
            }

            continue;
        }

        const value = await resolveSecret(account.credentials[field]);
        if (!value) {
            continue;
        }

        resolved[field] = value;
        resolved.source = typeof account.credentials[field] === "string" ? "literal" : "vault";
    }

    if (!resolved.apiKey && spec.fields.includes("apiKey")) {
        for (const name of envKeyNames(account, spec.envKeys)) {
            const value = env.ai.getByEnvKey(name);
            if (value) {
                resolved.apiKey = value;
                resolved.source = "env";
                resolved.envKey = name;
                logger.debug({ account: account.name, envKey: name }, "credential resolved from the environment");
                break;
            }
        }
    }

    const missing = (spec.required ?? []).filter((field) => !resolved[field]);
    if (missing.length > 0) {
        throw new CredentialUnavailableError(
            account.name,
            account.provider,
            `missing ${missing.join(", ")}. ${fixHint(account, spec, missing)}`
        );
    }

    return resolved;
}

/**
 * Non-throwing diagnosis for `doctor`: which source WOULD be used, without
 * revealing the value.
 */
export async function describeCredential(
    account: AccountEntry,
    spec: CredentialSpec
): Promise<{ ok: boolean; source?: CredentialSource; envKey?: string; detail: string }> {
    try {
        const resolved = await resolveCredential(account, spec);
        return {
            ok: true,
            source: resolved.source,
            envKey: resolved.envKey,
            detail: resolved.envKey ? `${resolved.source} (${resolved.envKey})` : resolved.source,
        };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
