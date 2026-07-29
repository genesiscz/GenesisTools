import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { envKeyNames } from "@genesiscz/utils/ai/config/selectors";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { out } from "@genesiscz/utils/logger";
import { isSecureRef } from "@genesiscz/utils/security";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/**
 * Presentation for the `tools ai config` command tree. Table chrome comes from
 * the shared helpers; only the AI-specific colouring and the credential-shape
 * reading live here.
 */

export type CredentialSource = "vault" | "literal" | "file" | "env" | "none";

/**
 * Where this account's credential WOULD come from, read from the config shape
 * alone.
 *
 * Deliberately does not call `resolveCredential`: listing accounts must not
 * decrypt the vault (a keychain prompt per `list`) and must never hold a secret
 * value. `doctor` does the real resolution when the user asks for a diagnosis.
 */
export function credentialSourceOf(account: AccountEntry, plugin?: ProviderPlugin): CredentialSource {
    const { credentials } = account;

    for (const field of ["apiKey", "accessToken", "refreshToken", "longLivedToken"] as const) {
        const value = credentials[field];
        if (isSecureRef(value)) {
            return "vault";
        }

        if (typeof value === "string" && value.length > 0) {
            return "literal";
        }
    }

    if (credentials.authFile || credentials.dataDir) {
        return "file";
    }

    if (envKeyNames(account, plugin?.credential.envKeys ?? []).length > 0) {
        return "env";
    }

    return "none";
}

const SOURCE_COLOR: Record<CredentialSource, (value: string) => string> = {
    vault: pc.green,
    file: pc.cyan,
    env: pc.yellow,
    literal: pc.red,
    none: pc.dim,
};

export function formatCredentialSource(source: CredentialSource): string {
    return SOURCE_COLOR[source](source);
}

export function formatBilling(account: AccountEntry): string {
    const { mode, plan } = account.billing;
    const label = plan ? `${mode} (${plan})` : mode;

    return mode === "subscription" ? pc.magenta(label) : mode === "free" ? pc.dim(label) : pc.yellow(label);
}

/** NAME PROVIDER KIND BILLING CRED STATUS, per the Phase 9 interface freeze. */
export function printAccountTable(accounts: AccountEntry[]): void {
    const table = createBoxTable(["NAME", "PROVIDER", "KIND", "BILLING", "CRED", "STATUS"]);

    for (const account of accounts) {
        const plugin = tryProviderPlugin(account.provider);
        table.push([
            pc.white(truncateDisplay(account.name, 24)),
            truncateDisplay(account.provider, 20),
            plugin ? plugin.kind : pc.red("no plugin"),
            formatBilling(account),
            formatCredentialSource(credentialSourceOf(account, plugin)),
            account.enabled ? formatDotStatus("ok", "enabled") : formatDotStatus("dim", "disabled"),
        ]);
    }

    out.println(table.toString());
}

export function printReferrerTable(referrers: Array<{ path: string; ref: string }>, knownIds?: Set<string>): void {
    const table = createBoxTable(["REFERENCE", "ACCOUNT", "STATE"]);

    for (const referrer of referrers) {
        const id = referrer.ref.replace(/^@account\//, "").split(":")[0];
        const dangling = knownIds ? !knownIds.has(id) : false;
        table.push([
            truncateDisplay(referrer.path, 46),
            truncateDisplay(id, 24),
            dangling ? formatDotStatus("err", "dangling") : formatDotStatus("ok", "resolves"),
        ]);
    }

    out.println(table.toString());
}
