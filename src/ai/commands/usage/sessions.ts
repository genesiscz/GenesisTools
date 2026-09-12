import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { type AgentSessionRow, listAgentSessionRows } from "../../lib/sessions/agent-session-rows";

interface SessionsOptions {
    provider?: string[] | boolean;
    hours?: string;
    min?: string;
    limit?: string;
    json?: boolean;
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

function render(rows: AgentSessionRow[]): void {
    renderCliHeader("Agent sessions", "every provider in one list");
    const table = createBoxTable(["AGE", "PROVIDER", "ACCOUNT", "TITLE", "CWD"]);
    const now = Date.now();

    for (const row of rows) {
        table.push([
            age(row.mtime, now),
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
 * reader (the Genesis menu-bar app) needs ONE client instead of one per provider, and so Codex
 * and Grok sessions can be listed at all — nothing downstream of `getSessionListing` had an
 * equivalent, because that wrapper stayed pinned to Claude when PR #370 made the service under
 * it provider-generic.
 */
export function registerAiUsageSessionsCommand(usage: Command): void {
    usage
        .command("sessions")
        .description("List recent sessions across Claude, Codex and Grok")
        .option("--provider [name...]", `Limit to these providers: ${ACCOUNT_PROVIDER_ALIASES.join(" | ")}`)
        .option("--hours <n>", "Only sessions touched in the last N hours")
        .option("--min <n>", "Top up with older sessions until at least N rows (Claude only)")
        .option("--limit <n>", "Cap the rows read per provider")
        .option("--json", "Emit the rows as JSON")
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

            const rows = await listAgentSessionRows({
                ...(named.length > 0 ? { providers: named as AccountProviderAlias[] } : {}),
                ...(positiveInt(opts.hours) === undefined ? {} : { hours: positiveInt(opts.hours) }),
                ...(positiveInt(opts.min) === undefined ? {} : { minRows: positiveInt(opts.min) }),
                ...(positiveInt(opts.limit) === undefined ? {} : { limit: positiveInt(opts.limit) }),
            });

            if (opts.json) {
                out.result({ fetchedAt: Date.now(), rows });
                return;
            }

            render(rows);
        });
}
