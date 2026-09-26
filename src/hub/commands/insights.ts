import { formatDuration, formatTokens } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import clipboardy from "clipboardy";
import type { Command } from "commander";
import pc from "picocolors";
import {
    DEFAULT_HANDOFF_PROMPTS,
    HandoffRangeError,
    parseThresholdFlag,
    postSessionHandoff,
    readStuckThresholds,
    type SessionInsights,
    type SessionStuck,
    type StuckThresholds,
    saveHandoff,
    sessionHandoff,
    sessionInsights,
    stuckConfigPath,
    stuckSessions,
    updateStuckThresholds,
} from "../lib/insights";
import type { HandoffRange } from "../lib/insights/handoff";

// `tools hub insights|stuck|handoff`: the CLI doors of the Session Details insights. The hub runs
// the same commands with `--json`, so everything the sidebar shows can be printed here too.

function usd(value: number | null): string {
    if (value === null) {
        return "—";
    }

    return value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

function ms(value: number | null): string {
    return value === null ? "—" : formatDuration(value, "ms", "tiered");
}

function fail(message: string): void {
    out.log.error(message);
    process.exitCode = 1;
}

function printInsights(insights: SessionInsights): void {
    const totals = insights.totals;
    renderCliHeader(`Session ${insights.sessionId.slice(0, 8)}`, insights.title ?? insights.provider);
    out.println(
        `${insights.turnCount} turns · ${insights.turns.length} prompts · ${totals.modelCalls} model calls · in ${formatTokens(totals.inputTokens)} · cache read ${formatTokens(totals.cacheReadTokens)} · cache write ${formatTokens(totals.cacheWriteTokens)} · out ${formatTokens(totals.outputTokens)} · ${insights.priced ? usd(totals.costUsd) : "not fully priced"}`
    );

    renderCliSection("Most expensive prompts");
    const ranked = insights.turns.filter((turn) => turn.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

    if (ranked.length === 0) {
        out.println(pc.dim("No model call recorded usage."));
    } else {
        const table = createBoxTable(["#", "PROMPT", "COST", "IN", "CACHE", "OUT", "TOOLS", "TOOK"]);

        for (const turn of ranked) {
            table.push([
                pc.white(`#${turn.number}`),
                truncateDisplay(turn.label, 48),
                usd(turn.costUsd),
                formatTokens(turn.inputTokens),
                formatTokens(turn.cacheReadTokens + turn.cacheWriteTokens),
                formatTokens(turn.outputTokens),
                turn.errorCount > 0
                    ? `${turn.toolCount} (${pc.red(`${turn.errorCount} failed`)})`
                    : String(turn.toolCount),
                ms(turn.durationMs),
            ]);
        }

        out.println(table.toString());
    }

    renderCliSection("Tools");

    if (insights.tools.length === 0) {
        out.println(pc.dim("No tool calls."));
    } else {
        const table = createBoxTable(["TOOL", "CALLS", "FAILED", "TOTAL", "SLOWEST", "TIMING"]);

        for (const tool of insights.tools) {
            table.push([
                pc.white(truncateDisplay(tool.name, 40)),
                String(tool.count),
                tool.failures > 0 ? pc.red(`${tool.failures} (${Math.round(tool.failureRate * 100)}%)`) : "0",
                ms(tool.totalMs),
                ms(tool.slowestMs),
                tool.timing === "exact" ? "exact" : pc.dim("≤ gap"),
            ]);
        }

        out.println(table.toString());
    }

    if (insights.stuck) {
        renderCliSection("Stuck");
        out.println(formatDotStatus("warn", insights.stuck.detail));
    }

    out.println(pc.dim(insights.pricingNote));
}

function printStuck(results: SessionStuck[], thresholds: StuckThresholds): void {
    const flagged = results.filter((result) => result.verdict !== null);
    renderCliHeader(
        "Stuck agents",
        `a call waiting ${thresholds.toolMinutes} min or longer, or ${thresholds.repeats} identical calls in a row`
    );

    if (flagged.length === 0) {
        out.println(formatDotStatus("ok", `none of ${results.length} checked sessions looks stuck`));
    } else {
        const table = createBoxTable(["SESSION", "KIND", "TOOL", "WHAT", "SINCE"]);

        for (const result of flagged) {
            const verdict = result.verdict;

            if (!verdict) {
                continue;
            }

            table.push([
                pc.white(
                    `${result.sessionId.slice(0, 8)}${result.title ? ` ${truncateDisplay(result.title, 28)}` : ""}`
                ),
                verdict.kind === "long-tool" ? pc.yellow("long call") : pc.red("loop"),
                truncateDisplay(verdict.tool, 24),
                truncateDisplay(`${verdict.argument}`, 40),
                ms(verdict.elapsedMs),
            ]);
        }

        out.println(table.toString());
    }

    const failed = results.filter((result) => result.error);

    for (const result of failed) {
        out.println(formatDotStatus("err", `${result.sessionId.slice(0, 8)}: ${result.error}`));
    }

    out.println(pc.dim(`Thresholds: ${stuckConfigPath()} · change with tools hub stuck config --tool-minutes 15`));
}

interface StuckFlags {
    session?: string[];
    toolMinutes?: string;
    repeats?: string;
    json?: boolean;
}

/** The saved thresholds with this run's flags over them; null after printing a flag error. */
function runThresholds(opts: StuckFlags): StuckThresholds | null {
    const thresholds = readStuckThresholds();

    try {
        return {
            ...thresholds,
            ...(opts.toolMinutes
                ? { toolMinutes: parseThresholdFlag("toolMinutes", "--tool-minutes", opts.toolMinutes) }
                : {}),
            ...(opts.repeats ? { repeats: parseThresholdFlag("repeats", "--repeats", opts.repeats) } : {}),
        };
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return null;
    }
}

interface HandoffFlags {
    last?: string;
    from?: string;
    to?: string;
    title?: string;
    cwd?: string;
    branch?: string;
    account?: string;
    out?: string;
    copy?: boolean;
    post?: boolean;
    owner?: boolean;
    json?: boolean;
}

function wholeNumber(flag: string, value: string): number {
    const parsed = Number(value);

    if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
        throw new HandoffRangeError(`${flag} takes a positive whole number, got ${value}`);
    }

    return parsed;
}

function handoffRange(opts: HandoffFlags): HandoffRange {
    if (opts.from !== undefined || opts.to !== undefined) {
        if (opts.last !== undefined) {
            throw new HandoffRangeError("--last and --from/--to exclude each other");
        }

        if (opts.from === undefined || opts.to === undefined) {
            throw new HandoffRangeError("--from and --to go together (the #N numbers the transcript shows)");
        }

        return { from: wholeNumber("--from", opts.from), to: wholeNumber("--to", opts.to) };
    }

    return { last: opts.last === undefined ? DEFAULT_HANDOFF_PROMPTS : wholeNumber("--last", opts.last) };
}

export function registerInsightsCommands(program: Command): void {
    program
        .command("insights")
        .description(
            "One session's per-prompt tokens and list-price cost, tool analytics and stuck verdict (the Session Details sidebar)"
        )
        .argument("<session>", "session id or a unique prefix (Claude, Codex or Grok)")
        .option("--fresh", "recompute instead of reading the per-file cache")
        .option("--json", "machine-readable output")
        .action(async (session: string, opts: { fresh?: boolean; json?: boolean }) => {
            try {
                const insights = await sessionInsights({ sessionId: session, fresh: opts.fresh });

                if (opts.json) {
                    out.result(insights);
                    return;
                }

                printInsights(insights);
            } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
            }
        });

    const stuck = program
        .command("stuck")
        .description("Running agents that look stuck: a tool call waiting too long, or the same call again and again");

    stuck
        .command("check", { isDefault: true })
        .description("Print the verdicts (the hub's session badge and header line show the same)")
        .option("--session <ids...>", "check these sessions; none checks every session active within the max age")
        .option("--tool-minutes <n>", "this run only: a call waiting this many minutes is stuck")
        .option("--repeats <n>", "this run only: this many identical calls in a row is a loop")
        .option("--json", "machine-readable output")
        .action(async (opts: StuckFlags) => {
            const thresholds = runThresholds(opts);

            if (!thresholds) {
                return;
            }

            const results = await stuckSessions({ sessionIds: opts.session, thresholds });

            if (opts.json) {
                out.result({ thresholds, checked: results.length, sessions: results });
                return;
            }

            printStuck(results, thresholds);
        });

    stuck
        .command("config")
        .description("Show or change the saved thresholds (~/.genesis-tools/hub/stuck.json)")
        .option("--tool-minutes <n>", "a call waiting this many minutes is stuck")
        .option("--repeats <n>", "this many identical calls in a row is a loop")
        .option("--max-age-hours <n>", "a call older than this belongs to a dead session, not a stuck one")
        .option("--active-minutes <n>", "a loop counts only while its last call is at most this old")
        .option("--reset", "start from the defaults")
        .option("--json", "machine-readable output")
        .action(
            async (opts: {
                toolMinutes?: string;
                repeats?: string;
                maxAgeHours?: string;
                activeMinutes?: string;
                reset?: boolean;
                json?: boolean;
            }) => {
                let change: Partial<StuckThresholds> & { reset?: boolean };

                try {
                    change = {
                        ...(opts.toolMinutes
                            ? { toolMinutes: parseThresholdFlag("toolMinutes", "--tool-minutes", opts.toolMinutes) }
                            : {}),
                        ...(opts.repeats ? { repeats: parseThresholdFlag("repeats", "--repeats", opts.repeats) } : {}),
                        ...(opts.maxAgeHours
                            ? { maxAgeHours: parseThresholdFlag("maxAgeHours", "--max-age-hours", opts.maxAgeHours) }
                            : {}),
                        ...(opts.activeMinutes
                            ? {
                                  activeMinutes: parseThresholdFlag(
                                      "activeMinutes",
                                      "--active-minutes",
                                      opts.activeMinutes
                                  ),
                              }
                            : {}),
                        ...(opts.reset ? { reset: true } : {}),
                    };
                } catch (error) {
                    fail(error instanceof Error ? error.message : String(error));
                    return;
                }

                const thresholds =
                    Object.keys(change).length > 0 ? await updateStuckThresholds(change) : readStuckThresholds();

                if (opts.json) {
                    out.result(thresholds);
                    return;
                }

                out.println(
                    `A call waiting ${thresholds.toolMinutes} min is stuck (up to ${thresholds.maxAgeHours} h old); ${thresholds.repeats} identical calls in a row is a loop (last call within ${thresholds.activeMinutes} min).`
                );
                out.println(pc.dim(`Ignored for long calls: ${thresholds.ignoreLongTools.join(", ") || "none"}`));
                out.println(pc.dim(`Ignored for loops: ${thresholds.ignoreRepeatTools.join(", ") || "none"}`));
                out.println(pc.dim(stuckConfigPath()));
            }
        );

    program
        .command("handoff")
        .description(
            "A markdown handoff of a range of one session's prompts, built from the transcript alone (no model call)"
        )
        .argument("<session>", "session id or a unique prefix")
        .option("--last <n>", `the last N prompts (default ${DEFAULT_HANDOFF_PROMPTS})`)
        .option("--from <n>", "first prompt: the #N number the transcript shows")
        .option("--to <n>", "last prompt: the #N number the transcript shows")
        .option("--title <text>", "the session's title (default: its first prompt)")
        .option("--cwd <path>", "the session's folder, for the resume line")
        .option("--branch <name>", "the session's branch")
        .option("--account <name>", "resume through this account")
        .option("--out <dir>", "also write handoff-<id>-p<from>-<to>.md into this folder")
        .option("--copy", "also copy the markdown to the clipboard")
        .option("--post", "also post it to the handoff store (handoff_post): open items become its tasks")
        .option("--owner", "with --post: post as the human owner in the session's folder (the hub does)")
        .option("--json", "machine-readable output")
        .action(async (session: string, opts: HandoffFlags) => {
            let range: HandoffRange;

            try {
                range = handoffRange(opts);
            } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
                return;
            }

            try {
                const draft = await sessionHandoff({
                    sessionId: session,
                    range,
                    title: opts.title,
                    cwd: opts.cwd,
                    branch: opts.branch,
                    account: opts.account,
                });
                const savedTo = opts.out ? saveHandoff(draft, opts.out) : null;

                if (opts.copy) {
                    await clipboardy.write(draft.markdown);
                }

                const posted = opts.post
                    ? postSessionHandoff(draft, { owner: opts.owner, cwd: opts.cwd, branch: opts.branch })
                    : null;
                const handoff = posted
                    ? { id: posted.handoff.id, name: posted.handoff.name ?? null, paste: posted.paste._agent }
                    : null;

                if (opts.json) {
                    out.result({ ...draft, savedTo, copied: opts.copy === true, posted: handoff });
                    return;
                }

                out.print(draft.markdown);

                if (savedTo) {
                    out.log.info(`Saved ${savedTo}`);
                }

                if (opts.copy) {
                    out.log.info("Copied to the clipboard");
                }

                if (handoff) {
                    out.log.info(`Posted handoff ${handoff.id}${handoff.name ? ` (${handoff.name})` : ""}`);
                }
            } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
            }
        });
}
