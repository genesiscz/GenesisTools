import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountIdentity } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithAccounts } from "@genesiscz/utils/ai/providers/registry";
import { suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import pc from "picocolors";
import { type CredentialKind, credentialKinds } from "./credential-kinds";
import { resolveAccountsProvider } from "./select-provider";

export interface RunListOptions {
    provider?: string | true;
    json?: boolean;
    tool: string;
    subcommand?: string[];
}

export interface AccountListRow {
    id: string;
    name: string;
    provider: string;
    alias: string;
    label?: string;
    enabled: boolean;
    /** WHICH credentials exist, never their values. */
    credentialKinds: CredentialKind[];
    identity?: { email?: string; accountUuid?: string; organizationUuid?: string; plan?: string };
}

/**
 * A DIAGNOSTIC: every plugin call carries `probe: true`, nothing is written, and
 * `usage.poll` is never reached. Listing accounts must never cost a grant.
 */
export async function collectAccountRows(providerId?: string): Promise<AccountListRow[]> {
    registerBuiltInPlugins();

    const store = await AiConfigStore.load();
    const plugins = pluginsWithAccounts().filter((plugin) => providerId === undefined || plugin.id === providerId);
    const rows: AccountListRow[] = [];

    for (const plugin of plugins) {
        for (const account of store.accounts({ provider: plugin.id })) {
            // A corrupt or unreadable auth file belongs to ONE account; listing
            // the others must still work (PR #360 review t4).
            let identity: AccountIdentity | undefined;

            try {
                identity = await plugin.accounts?.identityOf?.(account, { probe: true });
            } catch (err) {
                logger.warn({ err, account: account.id }, "identity decode failed — listing stored fields only");
            }

            rows.push({
                id: account.id,
                name: account.name,
                provider: plugin.id,
                alias: providerAliasOf(plugin.id),
                label: account.label,
                enabled: account.enabled,
                credentialKinds: credentialKinds(account),
                ...(identity ? { identity } : {}),
            });
        }
    }

    return rows;
}

export async function runList(opts: RunListOptions): Promise<void> {
    let providerId: string | undefined;

    // The flag ABSENT means every provider; the flag passed with no value means a
    // value is missing, and answering that with the full list hid the typo
    // instead of naming the possible values (gap/cli).
    if (opts.provider !== undefined) {
        const resolved = await resolveAccountsProvider({
            raw: opts.provider,
            // Never prompt: a list is a diagnostic, and the flag was typed.
            interactive: false,
            tool: opts.tool,
            subcommand: opts.subcommand,
        });

        if (resolved.status !== "ok") {
            out.printlnErr(resolved.status === "help" ? resolved.help : "Cancelled");
            process.exitCode = 1;
            return;
        }

        providerId = resolved.plugin.id;
    }

    const rows = await collectAccountRows(providerId);

    if (opts.json) {
        out.result({ accounts: rows });
        return;
    }

    if (rows.length === 0) {
        out.println(pc.dim("No subscription accounts configured."));
        out.println(pc.dim(`  Log in: ${suggestCommand(opts.tool, { subcommand: ["accounts", "login"] })}`));
        return;
    }

    renderCliHeader("AI accounts", "subscription logins and what each one holds");

    const table = createBoxTable(["PROVIDER", "ACCOUNT", "LABEL", "IDENTITY", "CREDENTIALS", "STATE"]);

    for (const row of rows) {
        table.push([
            pc.cyan(row.alias),
            pc.white(row.name),
            truncateDisplay(row.label ?? "", 14),
            truncateDisplay(row.identity?.email ?? row.identity?.accountUuid ?? "", 28),
            row.credentialKinds.join(", ") || pc.dim("none"),
            formatDotStatus(row.enabled ? "ok" : "dim", row.enabled ? "enabled" : "disabled"),
        ]);
    }

    out.println(table.toString());
    renderCliSection("Columns");
    out.println(pc.dim("  CREDENTIALS names WHICH credentials are stored, never their values."));
    out.println(
        pc.dim(
            `  ${rows.length} account${rows.length === 1 ? "" : "s"} · full inventory (every provider): ` +
                `${pc.cyan("tools ai config account list")}`
        )
    );
}
