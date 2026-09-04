import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithAccounts } from "@genesiscz/utils/ai/providers/registry";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import { resolveAccountsProvider } from "./select-provider";
import { writeLoginOutcome } from "./write-outcome";

export interface RunDiscoverOptions {
    provider?: string | true;
    /** Create an account for every unbound home. Without it this command is read-only. */
    bind?: boolean;
    json?: boolean;
    tool: string;
    subcommand?: string[];
}

export interface DiscoveredRow extends DiscoveredHome {
    provider: string;
    alias: string;
}

/**
 * WITHOUT `--bind` this is a diagnostic: every home is read off disk and every
 * identity is decoded from claims already stored, with no network and no write.
 * `--bind` is the one mutating path, and it goes through `writeLoginOutcome`
 * like every other login.
 */
export async function collectHomes(providerId?: string): Promise<DiscoveredRow[]> {
    registerBuiltInPlugins();

    const rows: DiscoveredRow[] = [];

    for (const plugin of pluginsWithAccounts()) {
        if (providerId !== undefined && plugin.id !== providerId) {
            continue;
        }

        for (const home of (await plugin.accounts?.discoverHomes?.()) ?? []) {
            rows.push({ ...home, provider: plugin.id, alias: providerAliasOf(plugin.id) });
        }
    }

    return rows;
}

export async function runDiscover(opts: RunDiscoverOptions): Promise<void> {
    registerBuiltInPlugins();

    let providerId: string | undefined;

    if (opts.provider !== undefined && opts.provider !== true && opts.provider !== "") {
        const resolved = await resolveAccountsProvider({
            raw: opts.provider,
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

    const rows = await collectHomes(providerId);

    if (opts.json && !opts.bind) {
        out.result({ homes: rows });
        return;
    }

    if (rows.length === 0) {
        out.println(pc.dim("No vendor homes found on this machine."));
        return;
    }

    renderCliHeader("Vendor homes", "profile directories the CLIs keep their logins in");

    const table = createBoxTable(["PROVIDER", "HOME", "IDENTITY", "BOUND"]);

    for (const row of rows) {
        table.push([
            pc.cyan(row.alias),
            truncateDisplay(row.home, 42),
            truncateDisplay(row.identity?.email ?? row.identity?.accountUuid ?? "", 28),
            row.boundToAccountId ? formatDotStatus("ok", row.boundToAccountId) : formatDotStatus("dim", "unbound"),
        ]);
    }

    out.println(table.toString());

    if (!opts.bind) {
        const unbound = rows.filter((row) => !row.boundToAccountId && row.authFile).length;
        out.println(
            pc.dim(
                `  ${rows.length} home${rows.length === 1 ? "" : "s"}, ${unbound} unbound. ` +
                    `Create accounts for them: ${pc.cyan(suggestCommand(opts.tool, { subcommand: opts.subcommand, add: ["--bind"] }))}`
            )
        );
        return;
    }

    await bindHomes(rows);
}

async function bindHomes(rows: DiscoveredRow[]): Promise<void> {
    const store = await AiConfigStore.load();
    const interactive = isInteractive();
    let created = 0;

    for (const row of rows) {
        // Only a home with a credential file is bindable; a worker home carries
        // transcripts but no login of its own.
        if (row.boundToAccountId || !row.authFile) {
            continue;
        }

        const name = row.identity?.email?.split("@")[0]?.toLowerCase() ?? `${row.alias}-${created + 1}`;

        const written = await writeLoginOutcome({
            name,
            interactive,
            account: store.account(name),
            outcome: {
                provider: row.provider,
                credentials: { authFile: row.authFile },
                ...(row.identity ? { identity: row.identity } : {}),
                ...(row.identity?.plan ? { accountFields: { label: row.identity.plan } } : {}),
            },
        });

        if (!written) {
            process.exitCode = 1;
            continue;
        }

        created += 1;
        out.println(pc.green(`✓ Bound ${row.home} as "${written.account.name}".`));
    }

    if (created === 0) {
        out.println(pc.dim("  Nothing to bind: every home with a credential file already has an account."));
    }
}
