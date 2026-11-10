import { readFileSync } from "node:fs";
import { type SourceMessage, sourceMessageSchema } from "@genesiscz/utils/agent/source-anchor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { formatTransclusionHelp } from "@genesiscz/utils/transclude";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { agentNote } from "../lib/agent-note";
import { isDecisionId, type QuestionItemInput, validateQuestionItems } from "../lib/decisions/items";
import { decisionFiles } from "../lib/decisions/read";
import { type DecisionRecord, updateDecisions } from "../lib/decisions/store";
import { answerInboxDecisions } from "../lib/inbox/answer";
import { waitingBlock } from "../lib/inbox/load";
import { answerAskForm, cancelAskForm, explainCancelRefusal, getAskForm, waitForAskForm } from "../lib/pending/ask";
import { summarizeForm } from "../lib/pending/render";
import { type AskAnswer, type AskForm, DEFAULT_WAIT_BUDGET_MS, type WaiterStatus } from "../lib/pending/types";
import { questionTokenRegistry } from "../lib/transclude";
import { type PostQuestionResult, pollQuestions, postQuestion, type QuestionVerbDeps } from "../lib/verbs";
import { collect } from "./options";

const { log } = logger.scoped("question-ask");

/** A waiter that did not get an answer exits non-zero so a script can branch on it. */
const WAITER_EXIT: Record<WaiterStatus, number> = {
    answered: 0,
    not_found: 1,
    timeout: 2,
    cancelled: 3,
    budget_exhausted: 4,
};

/**
 * Reject anything that is not a whole number of milliseconds.
 *
 * `Number` rather than `parseInt` on purpose: `parseInt` reads a PREFIX, so `"10ms"` became
 * 10 and `"1.5"` became 1, and a mistyped timeout then expired far earlier than asked for.
 * NaN was worse still: it made `--timeout` mean "no timeout" and gave `--wait-timeout` a
 * deadline no clock reaches.
 */
export function parseMs(value: string): number {
    // `Number("")` is 0, not NaN, so an empty `--timeout ''` used to read as a real value that
    // the checks below all accept.
    const trimmed = value.trim();
    const ms = Number(trimmed);

    if (!trimmed || !Number.isInteger(ms) || ms < 0) {
        throw new InvalidArgumentError("expected a whole, non-negative number of milliseconds");
    }

    return ms;
}

/** One element of `--json`: strict JSON proves syntax only, so `[null]` reaches us as null. */
function isAnswerShape(value: unknown): value is AskAnswer {
    return typeof value === "object" && value !== null && typeof (value as AskAnswer).itemId === "string";
}

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

/** Commander accumulator for a repeatable flag; also used by `inbox.ts`'s `--image`. */

const ASK_HELP_HINT = `Run ${toolCommand("question ask")} --help for the item shape.`;

/** `ask --help`: the `--json` item fields and one example, so an agent never guesses the names. */
const ASK_JSON_HELP = `
--json items (an array, or a question_post payload { items, projectPath?, source?, sessionHint?, sourceMessage?,
  timeoutMs?, wait?, waitTimeoutMs?, transclude? }):
  promptMarkdown   required. The question, markdown ok. (Not "prompt" or "question".)
  choices          answer options: labels, or { id, label } objects. (Not "options".)
  type             question (default: a pending form) | decision (numbered ❓ DECISION N) | todo (TODO N)
  title            decision/todo: short title shown after the number
  recommended      decision: the recommended option letter, e.g. "b"
  proposal         decision: what you would do
  reasoning        decision: markdown reasoning
  confidence       decision: high | medium | low
  blocking         decision: true when you cannot continue without the answer
  for              decision/todo: who acts on it, "human" (default for a decision), "agent" or a model name
  reevaluateWhen   decision/todo: a condition that reopens it, e.g. "after the PR merges"
  refs             decision: [{ path, line?, endLine?, sha? }]; the first ref's lines become the excerpt
  number           decision/todo: the number your chat reply already shows, so the log matches it
  supersedes       decision/todo: id of an open or drafted item this one replaces (it keeps its id and
                   number; the old text stays as a version: ${toolCommand("question show", "<id>", "--versions")})
  attachments      any item: screenshots, [{ "type": "image", "path": "/abs/shot.png", "label"?: "After" }];
                   copied into the question store and shown as previews on the inbox card
  allowMultiple    question: several choices may be ticked. decision: the user may pick any set of the
                   options (letters like "ac"); every inbox shows check boxes and one Send, and
                   recommended may name the set ("ac")
  id, allowFreeText, allowFileTags, allowImagePaste, required   question items only

Example:
  echo '[{"type":"decision","title":"Cache","promptMarkdown":"Keep the cache?","choices":["Keep it","Drop it"],"recommended":"a","blocking":true}]' \\
    | ${toolCommand("question ask", "--json", "-")}

Inline tokens in promptMarkdown, reasoning, proposal and choices are resolved when the item is saved
(--no-transclude skips; ${toolCommand("question tokens")} lists them, ${toolCommand("question tokens resolve")} "<text>" previews):
`;

/** The question_post fields `ask --json -` honours besides `items`; a CLI flag still wins. */
interface PostPayloadFields {
    projectPath?: string;
    source?: string;
    sessionHint?: string;
    sourceMessage?: SourceMessage;
    timeoutMs?: number;
    wait?: boolean;
    waitTimeoutMs?: number;
    transclude?: boolean;
}

function msField(payload: Record<string, unknown>, key: "timeoutMs" | "waitTimeoutMs"): number | undefined {
    const value = payload[key];

    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`question_post payload: ${key} must be a number of milliseconds. ${ASK_HELP_HINT}`);
    }

    return value;
}

/** Only the known payload fields, each checked for its type: a bad value fails here, not deep in the post. */
function payloadFields(payload: Record<string, unknown>): PostPayloadFields {
    const fields: PostPayloadFields = {};

    for (const key of ["projectPath", "source", "sessionHint"] as const) {
        const value = payload[key];

        if (value === undefined) {
            continue;
        }

        if (typeof value !== "string") {
            throw new Error(`question_post payload: ${key} must be a string. ${ASK_HELP_HINT}`);
        }

        fields[key] = value;
    }

    for (const key of ["wait", "transclude"] as const) {
        const value = payload[key];

        if (value === undefined) {
            continue;
        }

        if (typeof value !== "boolean") {
            throw new Error(`question_post payload: ${key} must be true or false. ${ASK_HELP_HINT}`);
        }

        fields[key] = value;
    }

    for (const key of ["timeoutMs", "waitTimeoutMs"] as const) {
        const value = msField(payload, key);

        if (value !== undefined) {
            fields[key] = value;
        }
    }

    if (payload.sourceMessage !== undefined) {
        const source = sourceMessageSchema.safeParse(payload.sourceMessage);

        if (!source.success) {
            throw new Error(
                `question_post payload: sourceMessage takes messageId, turnId or toolCallId strings. ${ASK_HELP_HINT}`
            );
        }

        fields.sourceMessage = source.data;
    }

    return fields;
}

/**
 * `--json <items>` is an array of items. `--json -` reads stdin, and there it may also be the
 * whole question_post payload (`{ items, projectPath?, source?, sessionHint?, sourceMessage?, timeoutMs?, wait?,
 * waitTimeoutMs?, transclude? }`), so an agent pipes the same JSON it would send the MCP tool.
 */
export function parseItems(opts: Record<string, unknown>): { items: QuestionItemInput[]; fields: PostPayloadFields } {
    const raw = opts.json === "-" ? readFileSync(0, "utf8") : opts.json;

    if (typeof raw === "string" && raw.trim()) {
        const parsed = SafeJSON.parse(raw, { strict: true });

        if (Array.isArray(parsed)) {
            return { items: validateQuestionItems(parsed, ASK_HELP_HINT), fields: {} };
        }

        if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
            const payload = parsed as Record<string, unknown>;
            return { items: validateQuestionItems(payload.items, ASK_HELP_HINT), fields: payloadFields(payload) };
        }

        throw new Error(
            `--json must be an array of items, or a question_post payload with an items array. ${ASK_HELP_HINT}`
        );
    }

    const question = typeof opts.q === "string" ? opts.q : "";

    if (!question.trim()) {
        throw new Error("either -q <question> or --json <items> is required");
    }

    return {
        items: [
            {
                promptMarkdown: question,
                choices: typeof opts.choices === "string" ? splitList(opts.choices) : undefined,
                allowMultiple: opts.multiple === true,
                allowFreeText: opts.freeText !== false,
                allowFileTags: opts.fileTags === true,
                allowImagePaste: opts.imagePaste === true,
                required: opts.optional !== true,
            },
        ],
        fields: {},
    };
}

function flag(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * The answers one `answer` invocation submits.
 *
 * `--json` exists because a partial submit is NEVER stored: `answerAskForm` refuses a form
 * with any required item still blank, so a multi-item form cannot be answered one `--item`
 * at a time. Without this the dashboard could answer forms the CLI could only ever refuse.
 */
function parseAnswers(
    form: AskForm,
    opts: { text?: string; choice: string[]; file: string[]; item?: string; json?: string }
): AskAnswer[] {
    const raw = opts.json;

    if (typeof raw === "string" && raw.trim()) {
        const parsed = SafeJSON.parse(raw, { strict: true });

        if (!Array.isArray(parsed)) {
            throw new Error("--json must be an array of answers");
        }

        if (!parsed.every(isAnswerShape)) {
            throw new Error("--json: every answer needs a string itemId");
        }

        return parsed;
    }

    const itemId = opts.item ?? form.items[0]?.id;

    if (!itemId) {
        throw new Error("this form has no items to answer");
    }

    return [
        {
            itemId,
            freeText: opts.text,
            selectedChoices: opts.choice.length > 0 ? opts.choice : undefined,
            fileTags: opts.file.length > 0 ? opts.file : undefined,
        },
    ];
}

/** `--supersedes <id>` names the one decision or todo item of the post; anything else is ambiguous. */
export function withSupersedes(items: QuestionItemInput[], id: string | undefined): QuestionItemInput[] {
    if (!id) {
        return items;
    }

    const stored = items.filter((item) => item.type === "decision" || item.type === "todo");

    if (stored.length !== 1) {
        throw new Error(`--supersedes needs exactly one decision or todo item in the post, found ${stored.length}`);
    }

    if (!isDecisionId(id)) {
        throw new Error(`--supersedes must be a decision or todo id like d_3_<session>, not "${id}"`);
    }

    return items.map((item) => (item === stored[0] ? { ...item, supersedes: id } : item));
}

/** One stderr line per failed token, then the summary; failures in yellow so they are not missed. */
function printTransclusionReport(lines: string[]): void {
    for (const line of lines) {
        out.printlnErr(line.includes(" resolved, 0 failed") ? pc.dim(line) : pc.yellow(line));
    }
}

function renderForm(form: AskForm): void {
    renderCliHeader(`Ask form ${form.id}`, `${form.status} · ${form.items.length} item(s)`);
    const table = createBoxTable(["ITEM", "PROMPT", "CHOICES", "ANSWER"]);

    for (const item of form.items) {
        const answer = form.answers?.[item.id];
        const given = [answer?.selectedChoices?.join(", "), answer?.freeText, answer?.fileTags?.join(" ")]
            .filter((part) => part && part.length > 0)
            .join(" · ");

        table.push([
            pc.white(item.id),
            truncateDisplay(item.promptMarkdown.replace(/\s+/g, " "), 48),
            truncateDisplay((item.choices ?? []).map((choice) => choice.label).join(", "), 24),
            truncateDisplay(given, 28),
        ]);
    }

    out.println(table.toString());
}

function renderPendingList(forms: AskForm[]): void {
    if (forms.length === 0) {
        out.println(pc.dim("No pending ask forms."));
        return;
    }

    renderCliHeader("Pending ask forms", `${forms.length} waiting`);
    const table = createBoxTable(["ID", "AGE", "SOURCE", "PROMPT"]);

    for (const form of forms) {
        table.push([
            pc.white(form.id),
            pc.dim(`${Math.round((Date.now() - form.createdAt) / 1000)}s`),
            pc.cyan(form.source ?? "-"),
            truncateDisplay(summarizeForm(form), 56),
        ]);
    }

    out.println(table.toString());
}

function decisionLine(id: string, row: DecisionRecord | null): string {
    if (!row) {
        return `${pc.red("✖")} ${id} ${pc.dim("unknown")}`;
    }

    return `${pc.green("●")} ${id} ${pc.cyan(row.state)} ${pc.dim(truncateDisplay((row.title ?? row.prompt).replace(/\s+/g, " "), 56))}`;
}

function renderAnswered(rows: DecisionRecord[]): void {
    if (rows.length === 0) {
        return;
    }

    renderCliHeader("Answered decisions not yet acknowledged", `mark them with ${toolCommand("question update")}`);

    for (const row of rows) {
        out.println(decisionLine(row.id, row));
    }
}

/**
 * The CLI door of a post: parse the flags and the `--json` items or payload, then post through the verb. A flag
 * wins over the same payload field. Exported so a test posts through this door over a scratch store.
 */
export async function postFromCli(
    opts: Record<string, unknown>,
    deps: QuestionVerbDeps = {}
): Promise<{ result: PostQuestionResult; wait: boolean }> {
    const parsed = parseItems(opts);
    const items = withSupersedes(parsed.items, flag(opts.supersedes));
    const { fields } = parsed;
    const wait = opts.wait === true || fields.wait === true;
    const result = await postQuestion(
        {
            items,
            projectPath: flag(opts.project) ?? fields.projectPath,
            source: flag(opts.source) ?? fields.source ?? "cli",
            sessionHint: flag(opts.session) ?? fields.sessionHint,
            sourceMessage: fields.sourceMessage,
            timeoutMs: typeof opts.timeout === "number" ? opts.timeout : fields.timeoutMs,
            waitTimeoutMs: typeof opts.waitTimeout === "number" ? opts.waitTimeout : fields.waitTimeoutMs,
            transclude: opts.transclude !== false && fields.transclude !== false,
        },
        { wait },
        { ...deps, notify: opts.notify !== false, transclude: { callerReports: true, ...deps.transclude } }
    );

    return { result, wait };
}

/** `d_<n>_<session>`: the number and the session a decision id names. */
function decisionAddress(id: string): { number: number; session: string } | null {
    const match = /^d_(\d+)_(.+)$/.exec(id);
    return match ? { number: Number(match[1]), session: match[2]! } : null;
}

export function registerAskCommand(program: Command): void {
    program
        .command("ask")
        .alias("post")
        .description("Ask the user a question and leave it pending until they answer (blocking ask)")
        .option("-q, --q <question>", "the question, markdown ok")
        .option("--choices <list>", "comma-separated choice labels")
        .option("--multiple", "allow more than one choice")
        .option("--no-free-text", "do not offer a free-text box")
        .option("--file-tags", "allow @file tags, resolved against the form cwd")
        .option("--image-paste", "allow pasted images")
        .option("--optional", "the item may be left blank")
        .option(
            "--json <items>",
            'items as a JSON array; "-" reads stdin, which may be the whole question_post payload. Items with type decision or todo are numbered in the decision log and printed as markdown'
        )
        .option("-p, --project <path>", "project path the question is about. Defaults to the harness checkout.")
        .option("--source <name>", "who is asking (agent, skill, app)")
        .option("--session <id>", "session id to attribute the answer to")
        .option("--timeout <ms>", "auto-retire the form after this long", parseMs)
        .option("--wait", "block until the form is answered, cancelled or timed out")
        .option("--wait-timeout <ms>", "how long --wait blocks before giving up", parseMs)
        .option("--no-notify", "do not raise a notification for this form or these decisions")
        .option("--no-transclude", "store {{…}} tokens as written instead of resolving them")
        .option(
            "--supersedes <id>",
            "replace this open or drafted decision/todo with the one decision/todo item posted"
        )
        .option("--format <fmt>", "human|json", "human")
        .addHelpText("after", () => `${ASK_JSON_HELP}${formatTransclusionHelp(questionTokenRegistry())}\n`)
        .action(async (opts: Record<string, unknown>) => {
            let posted: Awaited<ReturnType<typeof postFromCli>>;

            try {
                posted = await postFromCli(opts);
            } catch (err) {
                out.error(pc.red(err instanceof Error ? err.message : String(err)));
                process.exit(1);
            }

            const { result } = posted;
            printTransclusionReport(result.report);
            const transclusions = result.tokens.length > 0 ? { transclusions: result.tokens } : {};
            // The agent reads this: whether the widget is on screen, and what it still owes in the chat.
            const note = agentNote();

            if (!result.form) {
                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ ...result.posted, ...transclusions, agentNote: note }, null, 2));
                } else {
                    out.print(result.posted.markdown);
                    out.printlnErr(pc.yellow(`Note for the agent: ${note}`));
                }

                process.exit(0);
            }

            if (!result.wait) {
                if (opts.format === "json") {
                    out.result(
                        SafeJSON.stringify(
                            { form: result.form, ...result.posted, ...transclusions, agentNote: note },
                            null,
                            2
                        )
                    );
                } else {
                    renderForm(result.form);

                    if (result.posted.markdown) {
                        out.print(result.posted.markdown);
                    }

                    out.printlnErr(pc.yellow(`Note for the agent: ${note}`));
                }

                process.exit(0);
            }

            const waited = result.wait;
            log.debug({ id: result.form.id, waiter: waited.waiter }, "ask --wait finished");

            if (opts.format === "json") {
                out.result(SafeJSON.stringify(waited, null, 2));
            } else {
                out.printlnErr(pc.dim(`waiter: ${waited.waiter}`));

                if (waited.form) {
                    renderForm(waited.form);
                }
            }

            process.exit(WAITER_EXIT[waited.waiter]);
        });

    program
        .command("wait <id>")
        .description("Block until a pending ask form is answered, cancelled or times out")
        .option("--timeout <ms>", "how long to block before giving up", parseMs)
        .option("--format <fmt>", "human|json", "human")
        .action(async (id: string, opts: { timeout?: number; format?: string }) => {
            const result = await waitForAskForm(id, opts.timeout ?? DEFAULT_WAIT_BUDGET_MS);

            if (!result.form) {
                out.error(pc.red(`unknown form: ${id}`));
                process.exit(1);
            }

            if (opts.format === "json") {
                out.result(SafeJSON.stringify(result, null, 2));
            } else {
                out.printlnErr(pc.dim(`waiter: ${result.waiter}`));
                renderForm(result.form);
            }

            process.exit(WAITER_EXIT[result.waiter]);
        });

    program
        .command("poll [ids...]")
        .description(
            "Show pending ask forms and this session's unacknowledged answers, or the status of the form, decision and todo ids you name"
        )
        .option("--format <fmt>", "human|json", "human")
        .action((ids: string[], opts: { format?: string }) => {
            const polled = pollQuestions({ ids });

            if (polled.kind === "pending") {
                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ forms: polled.forms, answered: polled.answered }, null, 2));
                } else {
                    renderPendingList(polled.forms);
                    renderAnswered(polled.answered);
                }

                process.exit(0);
            }

            if (opts.format === "json") {
                const decisions = Object.fromEntries(polled.decisions.map(({ id, row }) => [id, row]));
                out.result(SafeJSON.stringify({ forms: polled.forms, decisions }, null, 2));
                process.exit(0);
            }

            for (const [id, form] of Object.entries(polled.forms)) {
                if (!form) {
                    out.println(`${pc.red("✖")} ${id} ${pc.dim("unknown")}`);
                    continue;
                }

                out.println(`${pc.green("●")} ${id} ${pc.cyan(form.status)} ${pc.dim(summarizeForm(form))}`);
            }

            for (const { id, row } of polled.decisions) {
                out.println(decisionLine(id, row));
            }

            process.exit(0);
        });

    program
        .command("answer <id>")
        .description("Answer a pending ask form, or a decision (d_<n>_<session>) with --option and/or --text")
        .option("-t, --text <text>", "free-text answer")
        .option("--option <letter>", "decision: the chosen option letter, e.g. b")
        .option("--choice <id>", "selected choice id (repeatable)", collect, [])
        .option("--file <path>", "@file tag, relative to the form cwd (repeatable)", collect, [])
        .option("--item <itemId>", "which item this answers (single-item forms default to the only one)")
        .option("--json <answers>", "answer several items at once: a JSON array of AskAnswer objects")
        .option("--format <fmt>", "human|json", "human")
        .action(
            async (
                id: string,
                opts: {
                    text?: string;
                    option?: string;
                    choice: string[];
                    file: string[];
                    item?: string;
                    json?: string;
                    format?: string;
                }
            ) => {
                const decision = decisionAddress(id);

                if (decision) {
                    // The user's own answer: checked and delivered like an inbox click (`answerInboxDecisions`).
                    let sent: Awaited<ReturnType<typeof answerInboxDecisions>>;

                    try {
                        sent = await answerInboxDecisions(
                            {
                                session: decision.session,
                                answers: [{ number: decision.number, option: opts.option, text: opts.text }],
                            },
                            { ...decisionFiles(), block: waitingBlock }
                        );
                    } catch (err) {
                        out.error(pc.red(err instanceof Error ? err.message : String(err)));
                        process.exit(1);
                    }

                    out.result(SafeJSON.stringify(sent, null, 2));
                    process.exit(0);
                }

                if (isDecisionId(id)) {
                    // A todo has no answer check or delivery: the user's own CLI answer is stored for `tools question send`.
                    const { file, events } = decisionFiles();
                    const [row] = await updateDecisions(
                        file,
                        events,
                        { updates: [{ id, state: "answered", answer: opts.text, option: opts.option }] },
                        undefined,
                        { actor: "user" }
                    );
                    out.result(SafeJSON.stringify(row, null, 2));
                    process.exit(0);
                }

                const form = getAskForm(id);

                if (!form) {
                    out.error(pc.red(`unknown form: ${id}`));
                    process.exit(1);
                }

                let answers: AskAnswer[];

                try {
                    answers = parseAnswers(form, opts);
                } catch (err) {
                    out.error(pc.red(err instanceof Error ? err.message : String(err)));
                    process.exit(1);
                }

                const outcome = await answerAskForm(id, answers);

                if (!outcome.ok) {
                    out.error(pc.red(outcome.error));

                    if (outcome.missing?.length) {
                        out.printlnErr(pc.dim(`  Still unanswered: ${outcome.missing.join(", ")}`));
                        out.printlnErr(
                            pc.dim("  A partial submit is never stored. Answer every item at once with --json.")
                        );
                    }

                    process.exit(1);
                }

                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ form: outcome.form, entryId: outcome.entryId }, null, 2));
                } else {
                    out.printlnErr(`${pc.green("✔")} answered ${id} ${pc.dim(`(logged as ${outcome.entryId})`)}`);
                    renderForm(outcome.form);
                }

                process.exit(0);
            }
        );

    program
        .command("cancel <id>")
        .description("Withdraw a pending ask form; a blocked waiter is released as cancelled")
        .option("--format <fmt>", "human|json", "human")
        .action((id: string, opts: { format?: string }) => {
            const form = cancelAskForm(id);

            if (!form) {
                out.error(pc.red(explainCancelRefusal(id).message));
                process.exit(1);
            }

            if (opts.format === "json") {
                out.result(SafeJSON.stringify({ form }, null, 2));
            } else {
                out.printlnErr(`${pc.green("✔")} cancelled ${id}`);
            }

            process.exit(0);
        });
}
