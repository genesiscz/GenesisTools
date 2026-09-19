import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type AgentSessionRow,
    type AgentSessionRowsOptions,
    listAgentSessionRows,
} from "../../lib/sessions/agent-session-rows";
import {
    cacheIsUsable,
    readSessionRowsCache,
    sessionRowsCacheKey,
    writeSessionRowsCache,
} from "../../lib/sessions/rows-cache";

interface SessionsOptions {
    provider?: string[] | boolean;
    hours?: string;
    min?: string;
    limit?: string;
    json?: boolean;
    fresh?: boolean;
}

function positiveInt(value: string | undefined): number | undefined {
    const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function age(mtime: number, now: number): string {
    const minutes = Math.max(0, Math.round((now - mtime) / 60_000));

    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function cacheCell(row: AgentSessionRow): string {
    if (!row.cacheStatus) {
        return pc.dim("—");
    }

    if (row.cacheStatus === "COLD") {
        return pc.dim("cold");
    }

    const minutes = Math.max(0, Math.ceil((row.cacheTtlSec ?? 0) / 60));
    const label = `${minutes}m`;

    if (row.cacheStatus === "CRITICAL") {
        return pc.red(label);
    }

    if (row.cacheStatus === "COOLING") {
        return pc.yellow(label);
    }

    return pc.green(label);
}

function render(rows: AgentSessionRow[]): void {
    renderCliHeader("Agent sessions", "every provider in one list");
    const table = createBoxTable(["AGE", "CACHE", "PROVIDER", "ACCOUNT", "TITLE", "CWD"]);
    const now = Date.now();

    for (const row of rows) {
        table.push([
            age(row.mtime, now),
            cacheCell(row),
            row.provider,
            row.account ?? pc.dim("—"),
            truncateDisplay(row.title ?? "", 48),
            truncateDisplay(row.cwdShort, 36),
        ]);
    }

    out.println(table.toString());
}

/**
 * `tools ai usage sessions`: the provider-neutral session list.
 *
 * `tools claude usage sessions --json` stays the rich Claude-only surface. This one exists so a
 * reader (the Genesis menu-bar app) needs ONE client instead of one per provider. Codex rows
 * carry a 30-minute prompt-cache clock (Codex documented minimum; Grok warning clock).
 */
export function registerAiUsageSessionsCommand(usage: Command): void {
    usage
        .command("sessions")
        .description("List recent sessions across Claude, Codex and Grok")
        .option("--provider [name...]", `Limit to these providers: ${ACCOUNT_PROVIDER_ALIASES.join(" | ")}`)
        .option("--hours <n>", "Only sessions touched in the last N hours")
        .option("--min <n>", "Top up with older sessions until at least N rows (Claude only)")
        .option("--limit <n>", "Cap the rows returned, newest first across every provider")
        .option("--json", "Emit the rows as JSON")
        .option("--fresh", "Recompute instead of reading the daemon's cached answer (--json only)")
        // `tools ai usage` declares --provider and --json itself, so commander attaches them to
        // the PARENT when they are typed after `sessions`. Without the merge every flag was
        // silently dropped and the command always printed every provider as a table.
        .action(async (_opts: SessionsOptions, command: Command) => {
            const opts = command.optsWithGlobals() as SessionsOptions;
            const named = Array.isArray(opts.provider) ? opts.provider : [];
            const bare = opts.provider !== undefined && named.length === 0;
            const known = new Set<string>(ACCOUNT_PROVIDER_ALIASES);
            const unknown = named.filter((name) => !known.has(name));

            if (bare || unknown.length > 0) {
                out.printlnErr(
                    suggestEnumFlag("tools ai usage", "--provider", [...ACCOUNT_PROVIDER_ALIASES], {
                        subcommand: ["sessions"],
                        ...(unknown[0] === undefined ? {} : { given: unknown[0] }),
                    })
                );
                process.exitCode = 1;
                return;
            }

            const listing: AgentSessionRowsOptions = {
                ...(named.length > 0 ? { providers: named as AccountProviderAlias[] } : {}),
                ...(positiveInt(opts.hours) === undefined ? {} : { hours: positiveInt(opts.hours) }),
                ...(positiveInt(opts.min) === undefined ? {} : { minRows: positiveInt(opts.min) }),
                ...(positiveInt(opts.limit) === undefined ? {} : { limit: positiveInt(opts.limit) }),
            };

            // The cache serves `--json` alone. That is the door Genesis.app polls every 35 s,
            // and the one whose consumer can read `fetchedAt` and decide for itself; a human
            // reading the table gets a freshly computed list every time.
            if (opts.json && !opts.fresh) {
                const key = sessionRowsCacheKey(listing);
                const cached = await readSessionRowsCache();
                const now = Date.now();

                if (cacheIsUsable(cached, key, now)) {
                    out.result({ fetchedAt: cached.fetchedAt, cached: true, rows: cached.rows });

                    // The stamp tells the daemon this query is still wanted, and it is read
                    // against an hour, so rewriting the whole file on every 35 s poll would be
                    // churn for nothing. Bumped at most twice a minute.
                    if (now - cached.lastRequestedAt > 30_000) {
                        const latest = await readSessionRowsCache();

                        if (latest && latest.fetchedAt === cached.fetchedAt) {
                            await writeSessionRowsCache({ ...latest, lastRequestedAt: now });
                        }
                    }

                    return;
                }
            }

            const rows = await listAgentSessionRows(listing);

            if (opts.json) {
                const now = Date.now();
                await writeSessionRowsCache({
                    query: listing,
                    fetchedAt: now,
                    lastRequestedAt: now,
                    rows,
                });
                out.result({ fetchedAt: now, cached: false, rows });
                return;
            }

            render(rows);
        });
}
