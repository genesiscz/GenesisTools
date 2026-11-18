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
        .command("context <session-ids...>")
        .description("Attribute context tokens and carry across model calls to their transcript sources")
        .addOption(providerOption())
        .option("--no-agents", "Read the main loop only")
        .option("--top <n>", "Rows in each source table", "25")
        .option("--agents-top <n>", "Agents to show by cache read", "15")
        .option("--items <n>", "Largest individual items by carry", "20")
        .option("--out <dir>", "Also write the session's JSON and text reports to a directory")
        .option("--record-metrics", "Append a new context.item snapshot to the metrics spool and report its id")
        .option("--json", "Print sessions.context@1")
        .action(
            async (
                ids: string[],
                opts: {
                    provider?: AccountProviderAlias;
                    agents: boolean;
                    top: string;
                    agentsTop: string;
                    items: string;
                    out?: string;
                    recordMetrics?: boolean;
                    json?: boolean;
                }
            ) => {
                try {
                    const count = (name: string, value: string) => {
                        const n = Number(value);
                        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
                            throw new Error(`${name} needs a nonnegative whole number.`);
                        }
                        return n;
                    };
                    const { printContext } = await import("../lib/sessions/session-context");
                    await printContext(ids, {
                        ...opts,
                        top: count("--top", opts.top),
                        agentsTop: count("--agents-top", opts.agentsTop),
                        items: count("--items", opts.items),
                    });
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );

    sessions
        .command("resumes [session-ids...]")
        .description("Show model-call pauses, cache hits and writes, and observed cache lifetimes")
        .addOption(providerOption())
        .option("--since <when>", "Include indexed main sessions modified since this duration or ISO date")
        .option("--project <name>", "Limit --since to this project")
        .option("--ttl-only", "Print only the cache lifetime table and reader coverage")
        .option("--waits", "Include tool waits in the text listing")
        .option("--top <n>", "Limit the number of loops in each text listing")
        .option("--cold", "Compare cold subagent and teammate resumes with starting fresh")
        .option("--idle-seconds <n>", "Shortest idle time in the cold comparison", "295")
        .option("--fresh-start <tokens>", "Initial context of a fresh agent in the comparison", "66000")
        .option("--price-model <id>", "Model to price the fresh-agent comparison", "opus")
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
                    top?: string;
                    cold?: boolean;
                    idleSeconds: string;
                    freshStart: string;
                    priceModel: string;
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
                    const top = opts.top === undefined ? Infinity : Number(opts.top);
                    const idleSeconds = Number(opts.idleSeconds);
                    const freshStart = Number(opts.freshStart);
                    if (
                        (opts.top !== undefined && (!Number.isSafeInteger(top) || top < 0)) ||
                        !Number.isFinite(idleSeconds) ||
                        idleSeconds < 0 ||
                        !Number.isSafeInteger(freshStart) ||
                        freshStart < 0
                    ) {
                        throw new Error(
                            "--top and --fresh-start need nonnegative integers; --idle-seconds needs a nonnegative duration."
                        );
                    }
                    const { printResumes } = await import("../lib/sessions/session-resumes");
                    await printResumes(ids, {
                        ...opts,
                        top,
                        idleSeconds,
                        freshStart,
                        sinceMs,
                        minGapMs: seconds * 1000,
                    });
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
