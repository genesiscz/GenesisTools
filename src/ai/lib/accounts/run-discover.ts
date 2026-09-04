import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithAccounts } from "@genesiscz/utils/ai/providers/registry";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
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

        // One provider's unreadable home directory must not hide every other
        // provider's homes: discovery walks the filesystem, so an EACCES or a
        // vanished dir is an expected outcome, not a reason to abort the whole
        // inventory (PR #360 review t4).
        let homes: DiscoveredHome[] = [];

        try {
            homes = (await plugin.accounts?.discoverHomes?.()) ?? [];
        } catch (err) {
            logger.warn({ err, provider: plugin.id }, "home discovery failed for this provider — skipping it");
            // stderr, not stdout: `--json` consumers still get a clean result.
            out.printlnErr(pc.yellow(`  ${providerAliasOf(plugin.id)}: could not read its homes — skipped.`));
        }

        for (const home of homes) {
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
    // `--json` owns stdout entirely, so nothing below may print there — the table
    // and the bind log used to run anyway and produced unparseable output for a
    // caller that passed both flags (PR #360 review t2).
    const quiet = opts.json === true;

    if (!opts.bind) {
        if (quiet) {
            out.result({ homes: rows });
            return;
        }

        if (rows.length === 0) {
            out.println(pc.dim("No vendor homes found on this machine."));
            return;
        }

        renderHomes(rows);

        const unbound = rows.filter((row) => !row.boundToAccountId && row.authFile).length;
        out.println(
            pc.dim(
                `  ${rows.length} home${rows.length === 1 ? "" : "s"}, ${unbound} unbound. ` +
                    `Create accounts for them: ${pc.cyan(suggestCommand(opts.tool, { subcommand: opts.subcommand, add: ["--bind"] }))}`
            )
        );
        return;
    }

    if (!quiet && rows.length > 0) {
        renderHomes(rows);
    }

    const bound = await bindHomes(rows, quiet);

    if (quiet) {
        out.result({ homes: rows, bound });
    }
}

function renderHomes(rows: DiscoveredRow[]): void {
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
}

/**
 * A name no other home in THIS run has already claimed.
 *
 * `writeLoginOutcome` merges onto an account of the same name, and after the
 * first write the store holds it — so two homes whose emails share a local part
 * (`me@work.com` and `me@personal.com`) both merged into one account, and the
 * second silently replaced the first one's credentials (PR #360 review t3).
 */
function uniqueInRun(base: string, taken: Set<string>): string {
    if (!taken.has(base)) {
        return base;
    }

    let suffix = 2;

    while (taken.has(`${base}-${suffix}`)) {
        suffix += 1;
    }

    return `${base}-${suffix}`;
}

export interface BoundHome {
    home: string;
    account: string;
    provider: string;
}

async function bindHomes(rows: DiscoveredRow[], quiet: boolean): Promise<BoundHome[]> {
    const store = await AiConfigStore.load();
    const interactive = isInteractive();
    const claimed = new Set<string>();
    const bound: BoundHome[] = [];
    let attempted = 0;

    for (const row of rows) {
        // Only a home with a credential file is bindable; a worker home carries
        // transcripts but no login of its own.
        if (row.boundToAccountId || !row.authFile) {
            continue;
        }

        // Numbered off ATTEMPTS, not successes: a refused write used to leave the
        // next home reusing the name that just failed.
        attempted += 1;
        const base = row.identity?.email?.split("@")[0]?.toLowerCase() ?? `${row.alias}-${attempted}`;
        const name = uniqueInRun(base, claimed);
        claimed.add(name);

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

        bound.push({ home: row.home, account: written.account.name, provider: row.provider });

        if (!quiet) {
            out.println(pc.green(`✓ Bound ${row.home} as "${written.account.name}".`));
        }
    }

    if (bound.length === 0 && !quiet) {
        out.println(pc.dim("  Nothing to bind: every home with a credential file already has an account."));
    }

    return bound;
}
