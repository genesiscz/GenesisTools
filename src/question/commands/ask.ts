import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    answerAskForm,
    cancelAskForm,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "../lib/pending/ask";
import { summarizeForm } from "../lib/pending/render";
import {
    type AskAnswer,
    type AskForm,
    type CreateAskItemInput,
    DEFAULT_WAIT_BUDGET_MS,
    type WaiterStatus,
} from "../lib/pending/types";

const { log } = logger.scoped("question-ask");

/** A waiter that did not get an answer exits non-zero so a script can branch on it. */
const WAITER_EXIT: Record<WaiterStatus, number> = {
    answered: 0,
    timeout: 2,
    cancelled: 3,
    budget_exhausted: 4,
};

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function parseItems(opts: Record<string, unknown>): CreateAskItemInput[] {
    const raw = opts.json;

    if (typeof raw === "string" && raw.trim()) {
        const parsed = SafeJSON.parse(raw, { strict: true });

        if (!Array.isArray(parsed)) {
            throw new Error("--json must be an array of items");
        }

        return parsed as CreateAskItemInput[];
    }

    const question = typeof opts.q === "string" ? opts.q : "";

    if (!question.trim()) {
        throw new Error("either -q <question> or --json <items> is required");
    }

    return [
        {
            promptMarkdown: question,
            choices: typeof opts.choices === "string" ? splitList(opts.choices) : undefined,
            allowMultiple: opts.multiple === true,
            allowFreeText: opts.freeText !== false,
            allowFileTags: opts.fileTags === true,
            allowImagePaste: opts.imagePaste === true,
            required: opts.optional !== true,
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
        .option("--json <items>", "multi-question form as a JSON array of items")
        .option("-p, --project <path>", "project path the question is about", process.cwd())
        .option("--source <name>", "who is asking (agent, skill, app)")
        .option("--session <id>", "session id to attribute the answer to")
        .option("--timeout <ms>", "auto-retire the form after this long", (v) => Number.parseInt(v, 10))
        .option("--wait", "block until the form is answered, cancelled or timed out")
        .option("--wait-timeout <ms>", "how long --wait blocks before giving up", (v) => Number.parseInt(v, 10))
        .option("--no-notify", "do not raise a notification for this form")
        .option("--format <fmt>", "human|json", "human")
        .action(async (opts: Record<string, unknown>) => {
            let items: CreateAskItemInput[];

            try {
                items = parseItems(opts);
            } catch (err) {
                out.error(pc.red(err instanceof Error ? err.message : String(err)));
                process.exit(1);
            }

            const form = await postAskForm(
                {
                    projectPath: String(opts.project ?? process.cwd()),
                    items,
                    timeoutMs: typeof opts.timeout === "number" ? opts.timeout : undefined,
                    source: typeof opts.source === "string" ? opts.source : "cli",
                    sessionHint: typeof opts.session === "string" ? opts.session : undefined,
                },
                { notify: opts.notify !== false }
            );

            if (opts.wait !== true) {
                if (opts.format === "json") {
                    out.result(SafeJSON.stringify({ form }, null, 2));
                } else {
                    renderForm(form);
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
        .option("--timeout <ms>", "how long to block before giving up", (v) => Number.parseInt(v, 10))
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
        .description("Answer a pending ask form from the terminal")
        .option("-t, --text <text>", "free-text answer")
        .option("--choice <id>", "selected choice id (repeatable)", collect, [])
        .option("--file <path>", "@file tag, relative to the form cwd (repeatable)", collect, [])
        .option("--item <itemId>", "which item this answers (single-item forms default to the only one)")
        .option("--format <fmt>", "human|json", "human")
        .action(
            async (
                id: string,
                opts: { text?: string; choice: string[]; file: string[]; item?: string; format?: string }
            ) => {
                const form = getAskForm(id);

                if (!form) {
                    out.error(pc.red(`unknown form: ${id}`));
                    process.exit(1);
                }

                const itemId = opts.item ?? form.items[0]?.id;

                if (!itemId) {
                    out.error(pc.red("this form has no items to answer"));
                    process.exit(1);
                }

                const answer: AskAnswer = {
                    itemId,
                    freeText: opts.text,
                    selectedChoices: opts.choice.length > 0 ? opts.choice : undefined,
                    fileTags: opts.file.length > 0 ? opts.file : undefined,
                };
                const outcome = await answerAskForm(id, [answer]);

                if (!outcome.ok) {
                    out.error(pc.red(outcome.error));

                    if (outcome.missing?.length) {
                        out.printlnErr(pc.dim(`  Still unanswered: ${outcome.missing.join(", ")}`));
                        out.printlnErr(
                            pc.dim("  Multi-item forms are answered on the dashboard, or one --item at a time.")
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
                out.error(pc.red(`not found, or already resolved: ${id}`));
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
