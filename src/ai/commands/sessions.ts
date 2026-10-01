import { hoursArg, limitArg } from "@app/hub/commands/agents-args";
import { ACCOUNT_PROVIDER_ALIASES, isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { DEFAULT_SEARCH_LIMIT, searchTranscript } from "@genesiscz/utils/ai/transcripts/search";
import { listSubagents } from "@genesiscz/utils/ai/transcripts/subagents";
import { DEFAULT_TURN_LIMIT, type TranscriptProvider } from "@genesiscz/utils/ai/transcripts/types";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

function parseProvider(value: string | undefined): TranscriptProvider | undefined {
    if (!value) {
        return undefined;
    }
    if (!isAccountProviderAlias(value)) {
        throw new Error(`--provider must be one of ${ACCOUNT_PROVIDER_ALIASES.join(", ")} (got "${value}")`);
    }
    return value;
}

/** A non-negative decimal integer, or null: `2oops`, `1.5` and `3x` are refused, never truncated. */
function wholeNumber(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A `--limit` count: a whole number of at least 1, or null. */
function parseLimit(value: string): number | null {
    const limit = wholeNumber(value);
    return limit !== null && limit >= 1 ? limit : null;
}

/** `3,17,902` → [3, 17, 902]; null when any entry is not a non-negative integer. */
function parseTurnList(value: string): number[] | null {
    const turns: number[] = [];
    for (const part of value.split(",")) {
        const turn = wholeNumber(part);
        if (turn === null) {
            return null;
        }

        turns.push(turn);
    }
    return turns;
}

export function registerSessionsCommands(program: Command): void {
    const sessions = program.command("sessions").description("Replay Claude, Grok, and Codex session JSONL");

    sessions
        .command("tail <session-id>")
        .description("Dump or follow a session (a worker name or a session id) as unified turns")
        .option("--format [value]", `output shape: ${TRANSCRIPT_FORMATS.join(" | ")} (default compact)`)
        .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
        .option("--json", "alias of --format json (the Genesis Session Details envelope)")
        .option("-f, --follow", "Follow the JSONL for new turns until Ctrl-C")
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option("--offset <n>", "Start at this turn index (default: last --limit turns)")
        .option("--limit <n>", "Max turns to emit", String(DEFAULT_TURN_LIMIT))
        .option("--turns <list>", "Exactly these 0-based turns, e.g. 3,17,902 (each gets its `index`)")
        .option(
            "--live",
            "follow for an app, from --offset: each turn as a JSON line with its `index`, again whenever it changes, then a totals line; runs until stdin closes"
        )
        .action(
            async (
                sessionId: string,
                opts: {
                    format?: string | boolean;
                    thoughts?: string | boolean;
                    json?: boolean;
                    follow?: boolean;
                    live?: boolean;
                    provider?: string;
                    offset?: string;
                    limit?: string;
                    turns?: string;
                }
            ) => {
                const turns = opts.turns === undefined ? undefined : parseTurnList(opts.turns);
                if (turns === null) {
                    process.exitCode = 2;
                    out.printlnErr("--turns must be a comma-separated list of non-negative integers");
                    return;
                }

                if (turns && (opts.follow || opts.live)) {
                    process.exitCode = 2;
                    out.printlnErr("--turns cannot be combined with --follow or --live");
                    return;
                }

                if (opts.live && opts.offset === undefined) {
                    process.exitCode = 2;
                    out.printlnErr(
                        "--live needs --offset: the first turn to send (a whole long session is not a live window)"
                    );
                    return;
                }

                const limit = parseLimit(opts.limit ?? String(DEFAULT_TURN_LIMIT));
                if (limit === null) {
                    process.exitCode = 2;
                    out.printlnErr("--limit must be a positive integer");
                    return;
                }

                const offset = opts.offset === undefined ? undefined : wholeNumber(opts.offset);
                if (offset === null) {
                    process.exitCode = 2;
                    out.printlnErr("--offset must be a non-negative integer");
                    return;
                }

                let provider: TranscriptProvider | undefined;
                try {
                    provider = parseProvider(opts.provider);
                } catch (error) {
                    process.exitCode = 2;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    return;
                }

                await runTranscriptDoor({
                    tool: "tools ai sessions tail",
                    subcommand: ["sessions", "tail"],
                    provider,
                    query: sessionId,
                    format: opts.format,
                    thoughts: opts.thoughts,
                    json: opts.json,
                    slice: turns ? { turns } : { offset, limit },
                    follow: opts.follow === true,
                    live: opts.live === true,
                });
            }
        );

    sessions
        .command("grep <session-id> <query>")
        .description("Find the turns of a whole session that show <query> (case-insensitive)")
        .option("--json", "print { sessionId, total, turns, truncated }")
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option(
            "--limit <n>",
            "Max turn indices to return (total still counts every match)",
            String(DEFAULT_SEARCH_LIMIT)
        )
        .action(
            async (sessionId: string, query: string, opts: { json?: boolean; provider?: string; limit?: string }) => {
                const limit = parseLimit(opts.limit ?? String(DEFAULT_SEARCH_LIMIT));
                if (limit === null) {
                    process.exitCode = 2;
                    out.printlnErr("--limit must be a positive integer");
                    return;
                }

                if (!query) {
                    process.exitCode = 2;
                    out.printlnErr("<query> must not be empty");
                    return;
                }

                try {
                    const resolved = await resolveTranscript(sessionId, {}, parseProvider(opts.provider));
                    const result = await searchTranscript(resolved, { query, limit });
                    if (opts.json) {
                        out.result(result);
                        return;
                    }

                    const more = result.truncated ? ` (first ${result.turns.length} shown)` : "";
                    out.println(`${result.total} matching turns in ${result.sessionId}${more}`);
                    if (result.turns.length > 0) {
                        out.println(result.turns.join(","));
                    }
                } catch (error) {
                    process.exitCode = 1;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                }
            }
        );

    sessions
        .command("subagents [session-id]")
        .description(
            "List a Claude session's sub-agents and teammates, and whether each still works; --all lists every recent session's tree, codex/grok workers included"
        )
        .option("--json", "print { sessionId, subagents: [{ id, name, description, state, startedAt, lastAt, … }] }")
        .option("--provider <name>", "claude | grok | codex (auto-detect if omitted)")
        .option("--all", "every session in the window with its agents (same as `tools hub agents`)")
        .option("--since <dur>", "with --all: window, 90m, 24h, 7d (default 24h)", hoursArg)
        .option("--limit <n>", "with --all: at most this many sessions", limitArg)
        .option("--session <id>", "with --all: one parent session (same as the positional id)")
        .option("--agent <id>", "with --all: one agent (id or name) with its whole spawn prompt")
        .action(
            async (
                sessionId: string | undefined,
                opts: {
                    json?: boolean;
                    provider?: string;
                    all?: boolean;
                    since?: number;
                    limit?: number;
                    session?: string;
                    agent?: string;
                }
            ) => {
                if (opts.all || !sessionId) {
                    if (!opts.all) {
                        out.printlnErr("Name a session id, or pass --all for every recent session.");
                        process.exitCode = 1;
                        return;
                    }

                    // lazy: saves 92.5 ms and 273 modules on every `ai sessions` call (tools ts imports lazy, 2026-10-01)
                    const { printAgentsTree } = await import("@app/hub/commands/agents");
                    await printAgentsTree({
                        since: opts.since,
                        limit: opts.limit,
                        session: sessionId ?? opts.session,
                        agent: opts.agent,
                        json: opts.json,
                    });
                    return;
                }

                try {
                    const resolved = await resolveTranscript(sessionId, {}, parseProvider(opts.provider));
                    const result = listSubagents(resolved);
                    if (opts.json) {
                        out.result(result);
                        return;
                    }

                    out.println(`${result.subagents.length} sub-agents in ${result.sessionId}`);
                    for (const agent of result.subagents) {
                        const label = [agent.name, agent.description ?? agent.agentType].filter(Boolean).join(": ");
                        out.println(`${agent.state.padEnd(8)} ${agent.lastAt}  ${label}`);
                    }
                } catch (error) {
                    process.exitCode = 1;
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                }
            }
        );
}
