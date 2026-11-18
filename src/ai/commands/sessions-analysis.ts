import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { parseDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { type Command, Option } from "commander";

function providerOption(): Option {
    return new Option("--provider <name>", "Limit the report to this harness").choices([...ACCOUNT_PROVIDER_ALIASES]);
}

function sinceTime(value: string): number {
    const duration = parseDuration(value);
    if (duration > 0) {
        return Date.now() - duration;
    }

    const at = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) {
        throw new Error("--since needs a positive duration such as 14d or an ISO date");
    }
    return at;
}

export function registerSessionAnalysis(sessions: Command): void {
    sessions
        .command("resumes [session-ids...]")
        .description("Show model-call pauses, cache hits and writes, and observed cache lifetimes")
        .addOption(providerOption())
        .option("--since <when>", "Include indexed main sessions modified since this duration or ISO date")
        .option("--project <name>", "Limit --since to this project")
        .option("--ttl-only", "Print only the cache lifetime table and reader coverage")
        .option("--waits", "Include tool waits in the text listing")
        .option("--min-gap <seconds>", "Shortest pause to include", "60")
        .option("--no-main", "Leave out the main loop")
        .option("--json", "Print sessions.resumes@1")
        .action(
            async (
                ids: string[],
                opts: {
                    since?: string;
                    provider?: AccountProviderAlias;
                    project?: string;
                    ttlOnly?: boolean;
                    waits?: boolean;
                    minGap: string;
                    main: boolean;
                    json?: boolean;
                }
            ) => {
                try {
                    if (!ids.length && !opts.since) {
                        throw new Error("Give a session id or --since.");
                    }
                    if (opts.project && !opts.since) {
                        throw new Error("--project requires --since.");
                    }
                    const seconds = Number(opts.minGap);
                    if (!opts.minGap.trim() || !Number.isFinite(seconds) || seconds < 0) {
                        throw new Error("--min-gap needs a non-negative number of seconds.");
                    }

                    const sinceMs = opts.since === undefined ? undefined : sinceTime(opts.since);
                    const { printResumes } = await import("../lib/sessions/session-resumes");
                    await printResumes(ids, { ...opts, sinceMs, minGapMs: seconds * 1000 });
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
