import { readFileSync } from "node:fs";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import {
    currentHarnessSession,
    DECISION_STATUSES,
    decisionFiles,
    decisionsMarkdown,
    loadSessions,
} from "../lib/decisions/read";
import { sendAnsweredDecisions } from "../lib/decisions/send";
import {
    checkStaleDecisions,
    installStaleTask,
    STALE_TASK_EVERY,
    STALE_TASK_NAME,
    staleTaskInstalled,
    uninstallStaleTask,
} from "../lib/decisions/stale";
import { type DecisionKind, updateDecisions } from "../lib/decisions/store";

export function readStdinJson(): unknown {
    return SafeJSON.parse(readFileSync(0, "utf8"), { strict: true });
}

/** `{ updates: [...] }`, a bare array of updates, or one update object: all mean the same batch. */
function asBatch(value: unknown): unknown {
    if (Array.isArray(value)) {
        return { updates: value };
    }

    if (typeof value === "object" && value !== null && !("updates" in value)) {
        return { updates: [value] };
    }

    return value;
}

function sessionOrThrow(session: string | undefined): string {
    const resolved = session ?? currentHarnessSession();

    if (!resolved) {
        throw new Error("pass --session; this process is not inside a harness");
    }

    return resolved;
}

function kindFrom(value: string | undefined): DecisionKind | undefined {
    if (value === undefined || value === "all") {
        return undefined;
    }

    if (value === "decision" || value === "todo") {
        return value;
    }

    throw new Error(`--type takes decision, todo or all, not ${value}`);
}

/**
 * The `--status` filter. An unknown name used to be kept, matched nothing, and read as "no
 * decisions", so a typo looked like an empty log. Null: the help is printed, stop with exit 1.
 */
async function statusFilter(raw: string | true | undefined): Promise<string[] | undefined | null> {
    if (raw === undefined) {
        return undefined;
    }

    const items =
        raw === true
            ? []
            : raw
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean);

    if (items.length === 0 && isInteractive()) {
        const picked = await p.multiselect({
            message: "Which statuses?",
            options: DECISION_STATUSES.map((status) => ({ value: status, label: status })),
        });

        return p.isCancel(picked) ? null : picked.map(String);
    }

    const unknown = items.filter((item) => !DECISION_STATUSES.includes(item));

    if (items.length === 0 || unknown.length > 0) {
        out.error(
            suggestEnumFlag("tools question list", "--status", DECISION_STATUSES, {
                subcommand: ["list"],
                given: unknown.length > 0 ? unknown.join(", ") : undefined,
            })
        );
        return null;
    }

    return items;
}

/**
 * The decision and todo doors of `tools question`: the hub window reads `list` and writes through
 * `answer`, `draft`, `update` and `send`; agents post through `ask --json -` or question_post.
 */
export function registerDecisionCommands(program: Command): void {
    program
        .command("list")
        .description("Decisions and todos grouped by session: the hub's read model")
        .option("--type <kind>", "decision, todo or all", "all")
        .option("--all-sessions", "Every session, not only the one running this command")
        .option("--session <id>")
        .option("--status [list]", `Comma-separated: ${DECISION_STATUSES.join(",")}; omit the value to pick`)
        .option("--json")
        .action(
            async (options: {
                type?: string;
                allSessions?: boolean;
                session?: string;
                status?: string | true;
                json?: boolean;
            }) => {
                const status = await statusFilter(options.status);

                if (status === null) {
                    process.exitCode = 1;
                    return;
                }

                const { file, events } = decisionFiles();
                let sessions = loadSessions(file, { status, type: kindFrom(options.type) });
                const session =
                    options.session ?? (options.allSessions ? undefined : (currentHarnessSession() ?? undefined));

                if (session) {
                    sessions = sessions.filter((item) => item.sessionId === session);
                }

                if (options.json || options.allSessions) {
                    out.result({ sessions, events });
                    return;
                }

                out.println(decisionsMarkdown(sessions.flatMap((item) => item.decisions)));
            }
        );

    program
        .command("update")
        .description(
            "Update decisions and todos as one change. JSON on stdin: { updates: [{ id, state?, answer?, option?, draft?, commitRefs?, verdict?, comment? }] }, an array of those, or one"
        )
        .action(async () => {
            const { file, events } = decisionFiles();
            out.result({ updated: await updateDecisions(file, events, asBatch(readStdinJson())), events });
        });

    program
        .command("draft <id>")
        .description("Save the user's unsent draft answer on a decision")
        .requiredOption("--text <text>")
        .action(async (id: string, options: { text: string }) => {
            const { file, events } = decisionFiles();
            const [row] = await updateDecisions(file, events, {
                updates: [{ id, state: "drafted", draft: options.text }],
            });
            out.result(row);
        });

    // No `answers` verb: `tools question answers` is `tail`'s alias. A session's answered decisions
    // are `list --session <id> --status answered,sent --json`.
    program
        .command("send")
        .description(
            "Deliver a session's answered decisions as one message: cmux pane for Claude and Grok, steer for a tools codex worker, else they stay queued for the next prompt"
        )
        .option("--session <id>", "defaults to the harness session")
        .option("--provider <name>", "claude, codex or grok (the store's value when omitted)")
        .option("--dry-run", "Print the message and the route; change nothing")
        .action(async (options: { session?: string; provider?: string; dryRun?: boolean }) => {
            out.result(
                await sendAnsweredDecisions({
                    session: sessionOrThrow(options.session),
                    ...(options.provider ? { provider: options.provider } : {}),
                    dryRun: options.dryRun,
                })
            );
        });

    program
        .command("stale")
        .description(
            "Blocking decisions waiting past decisions.staleness in the agents hooks config; --notify raises one notification per threshold, --install runs that every 5 minutes"
        )
        .option("--notify", "Notify each new crossing and remember it")
        .option("--install", `Register the ${STALE_TASK_NAME} daemon task: stale --notify ${STALE_TASK_EVERY}`)
        .option("--uninstall", `Remove the ${STALE_TASK_NAME} daemon task`)
        .action(async (options: { notify?: boolean; install?: boolean; uninstall?: boolean }) => {
            if (options.install || options.uninstall) {
                if (options.install) {
                    await installStaleTask();
                } else {
                    await uninstallStaleTask();
                }

                out.result({ task: STALE_TASK_NAME, installed: await staleTaskInstalled(), every: STALE_TASK_EVERY });
                return;
            }

            out.result(await checkStaleDecisions({ notify: Boolean(options.notify) }));
        });
}
