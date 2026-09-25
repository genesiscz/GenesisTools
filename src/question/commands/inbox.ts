import { loadHooksConfig } from "@app/agents/lib/hooks/config";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { resolveDeliveryTarget } from "../lib/decisions/deliver";
import { decisionFiles } from "../lib/decisions/read";
import {
    type AnswerDecisionDeps,
    answerInboxDecisions,
    answerInboxForm,
    type DecisionAnswer,
    type InboxAnswerResult,
} from "../lib/inbox/answer";
import { dismissDecision, draftDecision, sendDrafts } from "../lib/inbox/drafts";
import { loadInbox, loadSessionDecisions, waitingBlock } from "../lib/inbox/load";
import type { AskDeps } from "../lib/pending/ask";
import type { AskAnswer } from "../lib/pending/types";

const { log } = logger.scoped("question-inbox");

interface AnswerFlags {
    session?: string;
    provider?: string;
    cwd?: string;
    decision?: string;
    option?: string;
    text?: string;
    form?: string;
    answers?: string;
    batch?: string;
    dryRun?: boolean;
}

function positiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formAnswers(raw: string): AskAnswer[] {
    const parsed: unknown = SafeJSON.parse(raw, { strict: true });

    if (!Array.isArray(parsed)) {
        throw new Error('--answers takes a JSON array: [{"itemId":"q1","selectedChoices":["c1"]}]');
    }

    return parsed as AskAnswer[];
}

function singleAnswer(flags: AnswerFlags): DecisionAnswer {
    const number = Number.parseInt(flags.decision ?? "", 10);

    if (!Number.isFinite(number)) {
        throw new Error("--decision takes a number");
    }

    return { number, ...(flags.option ? { option: flags.option } : {}), ...(flags.text ? { text: flags.text } : {}) };
}

function batchAnswers(raw: string): DecisionAnswer[] {
    const parsed: unknown = SafeJSON.parse(raw, { strict: true });

    if (!Array.isArray(parsed)) {
        throw new Error('--batch takes a JSON array: [{"number":3,"option":"b","text":"note"}]');
    }

    return parsed.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || !("number" in entry) || typeof entry.number !== "number") {
            throw new Error("every --batch entry needs a numeric number");
        }

        const option = "option" in entry && typeof entry.option === "string" ? entry.option : undefined;
        const text = "text" in entry && typeof entry.text === "string" ? entry.text : undefined;
        return { number: entry.number, ...(option ? { option } : {}), ...(text ? { text } : {}) };
    });
}

/** The stores `inbox answer` writes. Tests pass a scratch decision log, a delivery spy and a scratch form store. */
export interface InboxCommandDeps {
    decisions?: () => AnswerDecisionDeps;
    forms?: AskDeps;
}

function realDecisionDeps(): AnswerDecisionDeps {
    return { ...decisionFiles(), block: waitingBlock };
}

async function answer(flags: AnswerFlags, deps: InboxCommandDeps): Promise<InboxAnswerResult> {
    const dryRun = flags.dryRun === true;

    if (flags.form) {
        if (!flags.answers) {
            throw new Error("--form needs --answers");
        }

        return answerInboxForm({
            formId: flags.form,
            answers: formAnswers(flags.answers),
            dryRun,
            ...(deps.forms ? { askDeps: deps.forms } : {}),
        });
    }

    if (!flags.session) {
        throw new Error("pass --session with --decision or --batch, or --form");
    }

    return answerInboxDecisions(
        {
            session: flags.session,
            answers: flags.batch ? batchAnswers(flags.batch) : [singleAnswer(flags)],
            ...(flags.provider ? { provider: flags.provider } : {}),
            ...(flags.cwd ? { cwd: flags.cwd } : {}),
            dryRun,
        },
        (deps.decisions ?? realDecisionDeps)()
    );
}

/**
 * `tools question inbox`: every session waiting on the user (a ❓ DECISION in its last reply, an
 * open decision, a pending form), grouped by session. The hub's Inbox mode reads `--json` and
 * answers through `inbox answer`.
 */
export function registerInboxCommand(program: Command, deps: InboxCommandDeps = {}): void {
    const inbox = program
        .command("inbox")
        .description("Sessions waiting for you: decisions in their last reply, open decisions, pending forms")
        .option("--hours <n>", "Sessions active in the last N hours", "72")
        .option("--session <id>", "Every decision of this one session, in every state: { sessionId, decisions }")
        .option("--json", "Print { sessions, scanned, elapsedMs }")
        .action(async (options: { hours?: string; session?: string; json?: boolean }) => {
            if (options.session) {
                const decisions = await loadSessionDecisions(options.session);

                if (options.json) {
                    out.result({ sessionId: options.session, decisions });
                    return;
                }

                for (const item of decisions) {
                    out.println(`DECISION ${item.number} [${item.status}] ${item.title ?? item.prompt}`);
                }

                return;
            }

            const result = await loadInbox({ hours: positiveInt(options.hours, 72) });

            if (options.json) {
                out.result(result);
                return;
            }

            renderCliHeader("Waiting for you", `${result.sessions.length} sessions · ${result.elapsedMs} ms`);
            const table = createBoxTable(["SESSION", "PROJECT", "WAITING", "ITEMS"]);

            for (const session of result.sessions) {
                table.push([
                    truncateDisplay(session.title ?? session.sessionId ?? "(no session)", 40),
                    truncateDisplay(session.project ?? "", 20),
                    String(session.waiting),
                    truncateDisplay(
                        session.items
                            .map((item) => (item.kind === "form" ? `form ${item.id}` : `DECISION ${item.number}`))
                            .join(", "),
                        40
                    ),
                ]);
            }

            out.println(table.toString());
        });

    inbox
        .command("answer")
        .description(
            "Answer decisions (typed into their session as one message) or a pending form, and print the delivery"
        )
        .option("--session <id>", "The session that asked")
        .option("--provider <name>", "claude, codex or grok (the store's value when omitted)")
        .option("--cwd <path>", "The session's folder, kept on a decision stored from its transcript")
        .option("--decision <n>", "The decision number")
        .option("--option <letter>", "The chosen option, a-z")
        .option("--text <answer>", "A free-text answer, or a note after the option")
        .option("--form <id>", "Answer this pending form instead")
        .option("--answers <json>", 'With --form: [{"itemId":"q1","selectedChoices":["c1"],"freeText":"…"}]')
        .option(
            "--batch <json>",
            'Several decisions of --session sent as one message: [{"number":3,"option":"b","text":"note"}]'
        )
        .option("--dry-run", "Print the line and the route; change nothing")
        .action(async (_flags: AnswerFlags, command: Command) => {
            // `inbox` itself takes --session, so commander hands it to the parent: read both.
            const flags: AnswerFlags = command.optsWithGlobals();

            try {
                out.result(await answer(flags, deps));
            } catch (error) {
                log.debug({ error }, "inbox answer refused");
                out.result({ error: error instanceof Error ? error.message : String(error) });
                const example = flags.form
                    ? [
                          "inbox",
                          "answer",
                          "--form",
                          flags.form,
                          "--answers",
                          '[{"itemId":"q1","selectedChoices":["c1"]}]',
                      ]
                    : ["inbox", "answer", "--session", "ID", "--decision", "1", "--option", "a"];
                out.printlnErr(suggestCommand("tools question", { replaceCommand: example }));
                process.exitCode = 1;
            }
        });

    const storeDeps = () => (deps.decisions ?? realDecisionDeps)();

    // `inbox` itself owns `--session` (list mode), so these read it through the globals, like `answer`.
    inbox
        .command("draft")
        .description("Mark or clear a decision's pick and note (the pick-then-send model); sends nothing")
        .requiredOption("--decision <n>", "The decision number")
        .option("--option <letters>", 'The chosen option letters, e.g. "b" or "ac"; empty clears the pick')
        .option("--text <note>", "The unsent note; empty clears it")
        .option("--provider <name>")
        .option("--cwd <path>")
        .action(async (_flags: AnswerFlags, command: Command) => {
            const flags: AnswerFlags = command.optsWithGlobals();

            try {
                if (!flags.session) {
                    throw new Error("--session is required");
                }

                const number = Number.parseInt(flags.decision ?? "", 10);

                if (!Number.isFinite(number)) {
                    throw new Error("--decision takes a number");
                }

                out.result(
                    await draftDecision(
                        {
                            session: flags.session,
                            number,
                            ...(flags.option !== undefined ? { option: flags.option } : {}),
                            ...(flags.text !== undefined ? { text: flags.text } : {}),
                            ...(flags.provider ? { provider: flags.provider } : {}),
                            ...(flags.cwd ? { cwd: flags.cwd } : {}),
                        },
                        storeDeps()
                    )
                );
            } catch (error) {
                log.debug({ error }, "inbox draft refused");
                out.result({ error: error instanceof Error ? error.message : String(error) });
                process.exitCode = 1;
            }
        });

    inbox
        .command("dismiss")
        .description("Drop a decision that no longer matters, without sending anything")
        .requiredOption("--decision <n>", "The decision number")
        .action(async (_flags: AnswerFlags, command: Command) => {
            const flags: AnswerFlags = command.optsWithGlobals();

            try {
                if (!flags.session) {
                    throw new Error("--session is required");
                }

                const number = Number.parseInt(flags.decision ?? "", 10);

                if (!Number.isFinite(number)) {
                    throw new Error("--decision takes a number");
                }

                const { file, events } = storeDeps();
                out.result(await dismissDecision({ session: flags.session, number }, { file, events }));
            } catch (error) {
                log.debug({ error }, "inbox dismiss refused");
                out.result({ error: error instanceof Error ? error.message : String(error) });
                process.exitCode = 1;
            }
        });

    inbox
        .command("send")
        .description("Promote a session's drafted answers and deliver them as one message (cmux, codex, or queued)")
        .option("--provider <name>")
        .option("--resume-target <label>", "The resume dialog reopened the session here: wait for its pane, then type")
        .option("--wait-live <seconds>", "Wait up to this long for the session's pane to be live before typing")
        .option("--dry-run", "Print the message and the route; change nothing")
        .action(async (_flags: unknown, command: Command) => {
            const flags: AnswerFlags & { resumeTarget?: string; waitLive?: string } = command.optsWithGlobals();

            try {
                if (!flags.session) {
                    throw new Error("--session is required");
                }

                const waitSeconds = Number.parseFloat(flags.waitLive ?? "0");
                out.result(
                    await sendDrafts(
                        {
                            session: flags.session,
                            ...(flags.provider ? { provider: flags.provider } : {}),
                            ...(flags.resumeTarget ? { recordResumeTarget: flags.resumeTarget } : {}),
                            ...(Number.isFinite(waitSeconds) && waitSeconds > 0
                                ? { waitLiveMs: Math.round(waitSeconds * 1000) }
                                : {}),
                            dryRun: flags.dryRun === true,
                        },
                        storeDeps()
                    )
                );
            } catch (error) {
                log.debug({ error }, "inbox send refused");
                out.result({ error: error instanceof Error ? error.message : String(error) });
                process.exitCode = 1;
            }
        });

    inbox
        .command("target")
        .description("Where a session's answers would go right now: a live cmux pane, a codex worker, or nothing")
        .option("--provider <name>")
        .action(async (_flags: unknown, command: Command) => {
            const flags: AnswerFlags = command.optsWithGlobals();

            // The same refusal as draft, dismiss and send: an empty id used to be looked up as a session.
            if (!flags.session) {
                out.result({ error: "--session is required" });
                process.exitCode = 1;
                return;
            }

            const target = await resolveDeliveryTarget({
                session: flags.session,
                ...(flags.provider ? { provider: flags.provider } : {}),
            });
            // Whether "Keep queued" means anything: only the UserPromptSubmit hook delivers a queued answer.
            out.result({ ...target, queueHookOn: loadHooksConfig().decisions.injectAnswers === true });
        });
}
