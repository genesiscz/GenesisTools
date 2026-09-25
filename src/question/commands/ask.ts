import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import {
    checkDecisionItems,
    isDecisionId,
    postDecisionItems,
    type QuestionItemInput,
    splitItems,
} from "../lib/decisions/items";
import { decisionFiles } from "../lib/decisions/read";
import { updateDecisions } from "../lib/decisions/store";
import {
    answerAskForm,
    cancelAskForm,
    explainCancelRefusal,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "../lib/pending/ask";
import { summarizeForm } from "../lib/pending/render";
import { type AskAnswer, type AskForm, DEFAULT_WAIT_BUDGET_MS, type WaiterStatus } from "../lib/pending/types";

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

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

/** The question_post fields `ask --json -` honours besides `items`; a CLI flag still wins. */
interface PostPayloadFields {
    projectPath?: string;
    source?: string;
    sessionHint?: string;
    timeoutMs?: number;
}

/**
 * `--json <items>` is an array of items. `--json -` reads stdin, and there it may also be the
 * whole question_post payload (`{ items, projectPath?, source?, sessionHint?, timeoutMs? }`), so an
 * agent pipes the same JSON it would send the MCP tool.
 */
function parseItems(opts: Record<string, unknown>): { items: QuestionItemInput[]; fields: PostPayloadFields } {
    const raw = opts.json === "-" ? readFileSync(0, "utf8") : opts.json;

    if (typeof raw === "string" && raw.trim()) {
        const parsed = SafeJSON.parse(raw, { strict: true });

        if (Array.isArray(parsed)) {
            return { items: parsed as QuestionItemInput[], fields: {} };
        }

        if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
            const { items, ...fields } = parsed as PostPayloadFields & { items: QuestionItemInput[] };
            return { items, fields };
        }

        throw new Error("--json must be an array of items, or a question_post payload with an items array");
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
        .option("--no-notify", "do not raise a notification for this form")
        .option("--format <fmt>", "human|json", "human")
        .action(async (opts: Record<string, unknown>) => {
            let parsed: ReturnType<typeof parseItems>;

            try {
                parsed = parseItems(opts);
            } catch (err) {
                out.error(pc.red(err instanceof Error ? err.message : String(err)));
                process.exit(1);
            }

            const { questions, decisions } = splitItems(parsed.items);
            const projectPath = flag(opts.project) ?? parsed.fields.projectPath;
            const sessionHint = flag(opts.session) ?? parsed.fields.sessionHint;
            const { file, events } = decisionFiles();
            const hint = { sessionId: sessionHint, cwd: projectPath };

            if (questions.length === 0) {
                const posted = await postDecisionItems({ file, events, items: decisions, hint });

                if (opts.format === "json") {
                    out.result(SafeJSON.stringify(posted, null, 2));
                } else {
                    out.print(posted.markdown);
                }

                process.exit(0);
            }

            // Both halves are checked before either is written; see `checkDecisionItems`.
            checkDecisionItems(decisions, hint);
            const form = await postAskForm(
                {
                    projectPath,
                    items: questions,
                    timeoutMs: typeof opts.timeout === "number" ? opts.timeout : parsed.fields.timeoutMs,
                    source: flag(opts.source) ?? parsed.fields.source ?? "cli",
                    sessionHint,
                },
                { notify: opts.notify !== false }
            );
            const posted = await postDecisionItems({ file, events, items: decisions, hint });

            if (opts.wait !== true) {
                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ form, ...posted }, null, 2));
                } else {
                    renderForm(form);

                    if (posted.markdown) {
                        out.print(posted.markdown);
                    }
                }

                process.exit(0);
            }

            const budget = typeof opts.waitTimeout === "number" ? opts.waitTimeout : DEFAULT_WAIT_BUDGET_MS;
            const result = await waitForAskForm(form.id, budget);
            log.debug({ id: form.id, waiter: result.waiter }, "ask --wait finished");

            if (opts.format === "json") {
                out.result(SafeJSON.stringify(result, null, 2));
            } else {
                out.printlnErr(pc.dim(`waiter: ${result.waiter}`));

                if (result.form) {
                    renderForm(result.form);
                }
            }

            process.exit(WAITER_EXIT[result.waiter]);
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
        .description("Show pending ask forms, or the status of the ids you name")
        .option("--format <fmt>", "human|json", "human")
        .action((ids: string[], opts: { format?: string }) => {
            if (ids.length === 0) {
                const forms = listPendingForms();

                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ forms }, null, 2));
                } else {
                    renderPendingList(forms);
                }

                process.exit(0);
            }

            const forms = pollAskForms(ids);

            if (opts.format === "json") {
                out.result(SafeJSON.stringify({ forms }, null, 2));
                process.exit(0);
            }

            for (const [id, form] of Object.entries(forms)) {
                if (!form) {
                    out.println(`${pc.red("✖")} ${id} ${pc.dim("unknown")}`);
                    continue;
                }

                out.println(`${pc.green("●")} ${id} ${pc.cyan(form.status)} ${pc.dim(summarizeForm(form))}`);
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
                if (isDecisionId(id)) {
                    const { file, events } = decisionFiles();
                    const [row] = await updateDecisions(file, events, {
                        updates: [{ id, state: "answered", answer: opts.text, option: opts.option }],
                    });
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
