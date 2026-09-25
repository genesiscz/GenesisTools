import { answerAskForm, getAskForm } from "@app/question/lib/pending/ask";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { listRecentCachedSessions } from "@genesiscz/utils/agent-sessions/cached-title";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import {
    answerDecision,
    buildQuestionAnswer,
    claudeSessionExists,
    type DecideInput,
    decisionLinks,
    linksSession,
    validateTarget,
} from "../lib/decide";
import { sendCommand } from "./cmux/send";

interface DecideFlags {
    session?: string;
    decision?: string;
    option?: string;
    question?: string;
    links?: string;
    labels?: string;
}

export function registerDecideCommand(program: Command): void {
    const decide = program
        .command("decide")
        .description("Type one DECISION answer into the cmux pane running that Claude session")
        .option("--session <id>", "Claude session id (links: defaults to the session running this command)")
        .option("--decision <n>", "Decision number")
        .option("--option <letter>", "One letter, a-z (required unless --links)")
        .option("--question <formId>", "Also answer this pending `tools question` form, so /qa keeps the answer")
        .option("--links <letters>", "Instead of sending, print markdown links for these comma-separated options")
        .option("--labels <texts>", "With --links: comma-separated link texts, one per option")
        .action(async (options: DecideFlags) => {
            try {
                if (options.links) {
                    await printLinks({ ...options, options: options.links });
                    return;
                }

                const { input, text } = await answerDecision(
                    { session: options.session ?? "", decision: options.decision ?? "", ...pick(options) },
                    {
                        sessionExists: (session) => claudeSessionExists(session),
                        send: (session, line) => sendCommand(session, line, { enter: true }),
                    }
                );
                out.println(text);

                if (input.question) {
                    await recordQuestionAnswer(input);
                }
            } catch (error) {
                fail(error);
            }
        });

    // --session, --decision, --labels and --question belong to `decide` and are read from it here.
    decide
        .command("links")
        .description(
            "Print one markdown link per option; paste them under a ❓ DECISION " +
                "(tools claude decide links --decision 4 --options a,b,c [--labels ...] [--session ID])"
        )
        .requiredOption("--options <letters>", "Comma-separated letters, e.g. a,b,c")
        .action(async (_options: { options: string }, command: Command) => {
            try {
                const merged: DecideFlags & { options: string } = command.optsWithGlobals();
                await printLinks(merged);
            } catch (error) {
                fail(error, ["decide", "links", "--session", "ID", "--decision", "1", "--options", "a,b"]);
            }
        });
}

function pick(options: DecideFlags): { option?: string; question?: string } {
    return {
        ...(options.option === undefined ? {} : { option: options.option }),
        ...(options.question === undefined ? {} : { question: options.question }),
    };
}

/** The session defaults to the harness this command runs in (its hook context), then to a picker in a terminal. */
async function printLinks(options: DecideFlags & { options: string }): Promise<void> {
    const session = await linksSession(options.session, {
        current: currentSession,
        interactive: isInteractive,
        recent: () => listRecentCachedSessions({ providerId: "anthropic-sub", limit: 20 }),
        select: async (choices) => {
            const picked = await p.select({ message: "Which Claude session are the links for?", options: choices });
            return typeof picked === "string" ? picked : null;
        },
    });
    const target = validateTarget({ session, decision: options.decision ?? "" });
    out.print(
        `${decisionLinks({
            session: target.session,
            decision: target.decision,
            options: options.options.split(","),
            labels: options.labels?.split(",") ?? [],
            question: options.question,
        })}\n`
    );
}

function currentSession(): string | null {
    const poster = gatherHarnessPoster();
    return poster.agent === "claude-code" && poster.sessionId ? poster.sessionId : null;
}

/**
 * The second channel: the pending form closes with the same letter. The line is already typed,
 * so a form that cannot take it is a warning, not a failed answer.
 */
async function recordQuestionAnswer(input: DecideInput): Promise<void> {
    const formId = input.question ?? "";
    const form = getAskForm(formId);
    const answer = form ? buildQuestionAnswer(form.items, input) : null;

    if (!answer) {
        out.warn(`question ${formId} not found; the answer was typed but not recorded`);
        return;
    }

    try {
        const outcome = await answerAskForm(formId, [answer]);

        if (outcome.ok) {
            logger.debug({ formId, entryId: outcome.entryId }, "decide: recorded the answer on the question form");
            out.println(`recorded on question ${formId}`);
            return;
        }

        out.warn(`question ${formId}: ${outcome.error}`);
    } catch (error) {
        logger.warn({ error, formId }, "decide: could not record the answer on the question form");
        out.warn(`question ${formId}: the answer was typed but not recorded`);
    }
}

function fail(error: unknown, fix: string[] = ["decide", "--session", "ID", "--decision", "1", "--option", "a"]): void {
    const message = error instanceof Error ? error.message : String(error);
    // The message is printed below; the stack goes to the log file only.
    logger.debug({ error }, "decide: refused");
    out.error(message);
    out.error(suggestCommand("tools claude", { replaceCommand: fix }));
    process.exitCode = 1;
}
