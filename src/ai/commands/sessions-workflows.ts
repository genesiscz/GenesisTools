import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { pickSessionProvider, sessionProviderOption } from "./session-provider";

interface SessionOptions {
    provider?: string | boolean;
    json?: boolean;
}

/** The session a verb names, or null after the reason was printed. */
async function sessionOf(sessionId: string, opts: SessionOptions, verb: string): Promise<ResolvedTranscript | null> {
    const picked = await pickSessionProvider(opts.provider, ["sessions", "workflows", verb]);
    if (!picked) {
        return null;
    }

    try {
        return await resolveTranscript(sessionId, {}, picked.provider);
    } catch (error) {
        out.printlnErr(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return null;
    }
}

/** A flag that takes a whole number of at least `min`, or undefined after the refusal was printed. */
function wholeNumberFlag(flag: string, value: string | undefined, min: number): number | null | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!/^\d+$/.test(value.trim()) || Number(value) < min) {
        out.printlnErr(`${flag} "${value}" is not a whole number of at least ${min}.`);
        process.exitCode = 1;
        return null;
    }

    return Number(value);
}

/** Runs a verb's printer and turns a thrown answer ("no run matches", "returned no result") into exit code 1. */
async function answer(print: () => Promise<void>): Promise<void> {
    try {
        await print();
    } catch (error) {
        process.exitCode = 1;
        out.printlnErr(error instanceof Error ? error.message : String(error));
    }
}

/**
 * `tools ai sessions workflows`: the multi-agent runs a session started (Claude Code's Workflow tool). Their agents
 * live outside the session's direct sub-agents, with a run record and a journal, so they have a reader of their own
 * (`NativeSessionReader.workflows`). A harness with no such tool answers with the reason, never with "0 runs".
 */
export function registerSessionsWorkflowsCommand(sessions: Command): void {
    const workflows = sessions
        .command("workflows")
        .description(
            "The Workflow tool runs of a session: list them, show one, grep its agents, print an agent's result"
        );

    workflows
        .command("list [session-id]")
        .description("The runs of a session; without a session, which providers have a workflow reader")
        .option("--agents", "Each run with its agents: the whole run in --json, a table under each run otherwise")
        .option("--usage", "Read every agent transcript of every run for its calls, tokens and list-price cost")
        .addOption(sessionProviderOption())
        .option(
            "--json",
            `Print { schema: "sessions.workflows@1", sessionId, provider, reader, runs, usage? }; with --agents each run is the whole run that "show --json" prints`
        )
        .action(async (sessionId: string | undefined, opts: SessionOptions & { agents?: boolean; usage?: boolean }) => {
            // Lazy: the readers and the pricing catalog load only for this verb.
            const lib = await import("@app/ai/lib/sessions/session-workflows");

            if (!sessionId) {
                lib.printWorkflowReaders(opts);
                return;
            }

            const session = await sessionOf(sessionId, opts, "list");

            if (session) {
                await answer(() => lib.printWorkflowList(session, opts));
            }
        });

    workflows
        .command("show <session-id> <run>")
        .description(
            "One run (id prefix or name): its record, and each agent with its label, phase, model, state and result"
        )
        .option("--usage", "Read every agent transcript for its calls, tokens, list-price cost and tool calls")
        .addOption(sessionProviderOption())
        .option("--json", `Print { schema: "sessions.workflows@1", sessionId, run, usage? }`)
        .action(async (sessionId: string, run: string, opts: SessionOptions & { usage?: boolean }) => {
            const session = await sessionOf(sessionId, opts, "show");

            if (session) {
                const lib = await import("@app/ai/lib/sessions/session-workflows");
                await answer(() => lib.printWorkflowRun(session, run, opts));
            }
        });

    workflows
        .command("grep <session-id> <pattern>")
        .description(
            "Which workflow agents have a transcript row that matches the regular expression, and whether the agent wrote it (assistant), was shown it (tool-result) or was told it (prompt)"
        )
        .option("--run <run>", "Only this run (id prefix or name)")
        .option("-i, --ignore-case", "Match without case")
        .option("--before <iso>", "Skip rows at or after this ISO instant")
        .option("--max-hits <n>", "Excerpts kept per agent; every matching line is still counted (default 3)")
        .option("--context <n>", "Characters of context on each side of a match (default 100)")
        .addOption(sessionProviderOption())
        .option("--json", `Print { schema: "sessions.workflows@1", sessionId, pattern, agents }`)
        .action(
            async (
                sessionId: string,
                pattern: string,
                opts: SessionOptions & {
                    run?: string;
                    ignoreCase?: boolean;
                    before?: string;
                    maxHits?: string;
                    context?: string;
                }
            ) => {
                const maxHits = wholeNumberFlag("--max-hits", opts.maxHits, 1);
                const context = wholeNumberFlag("--context", opts.context, 0);

                if (maxHits === null || context === null) {
                    return;
                }

                if (opts.before !== undefined && !Number.isFinite(Date.parse(opts.before))) {
                    out.printlnErr(`--before "${opts.before}" is not an ISO instant such as 2026-11-01T10:00:00Z.`);
                    process.exitCode = 1;
                    return;
                }

                let expression: RegExp;

                try {
                    expression = new RegExp(pattern, opts.ignoreCase ? "i" : "");
                } catch (error) {
                    out.printlnErr(
                        `"${pattern}" is not a regular expression: ${error instanceof Error ? error.message : String(error)}`
                    );
                    process.exitCode = 1;
                    return;
                }

                const session = await sessionOf(sessionId, opts, "grep");

                if (session) {
                    const lib = await import("@app/ai/lib/sessions/session-workflows");
                    await answer(() =>
                        lib.printWorkflowGrep(session, {
                            pattern: expression,
                            run: opts.run,
                            before: opts.before === undefined ? undefined : new Date(opts.before).toISOString(),
                            maxHits,
                            context,
                            json: opts.json,
                        })
                    );
                }
            }
        );

    workflows
        .command("result <session-id> <run> [agent]")
        .description(
            "The final structured answer of one agent of a run (its id or a prefix, its label or a part of it), or of every agent of the run when no agent is named, as JSON"
        )
        .addOption(sessionProviderOption())
        .action(async (sessionId: string, run: string, agent: string | undefined, opts: SessionOptions) => {
            const session = await sessionOf(sessionId, opts, "result");

            if (session) {
                const lib = await import("@app/ai/lib/sessions/session-workflows");
                await answer(() => lib.printWorkflowResult(session, run, agent));
            }
        });
}
