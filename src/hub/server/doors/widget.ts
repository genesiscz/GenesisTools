import { readFileSync } from "node:fs";
import { asResult } from "@genesiscz/utils/cli/result";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { WIDGET_TASK_SCOPES, type WidgetTaskFilters } from "../../lib/widget/tasks";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type CallDoor, failed, ok } from "./types";

const { log } = logger.scoped("hub:server");

/**
 * The widget actions the server answers: each one sets a value in the widget's state, the decision ledger or the
 * read model under its own lock, so a retry by the process after a dropped connection sets the same value again. Every
 * other action stays a process: a send or an enqueue reaches an agent, a capture waits on the screen picker (a TCC
 * grant), an import copies files, and an append adds its text twice when it is retried.
 */
const DOOR_ACTIONS: ReadonlySet<string> = new Set([
    "selection",
    "ledger",
    "unstage",
    "preferences",
    "visibility",
    "draft",
    "draft-text",
    "read",
    "inbox-read",
    "inbox-clear",
]);

function actionOf(input: unknown): string | undefined {
    if (typeof input !== "object" || input === null || !("action" in input)) {
        return undefined;
    }

    return typeof input.action === "string" ? input.action : undefined;
}

/**
 * `hub widget call --input <file>`: one widget action (stage, unstage, a preference, a selection, a read). Every
 * action was a process, 0.36 s of CPU each, 145 in a day. The request file is read here, so an action this door does
 * not take still goes to the process. `--state-root` (the preview build's own state) stays a process too.
 */
export const widgetCallDoor: CallDoor<unknown> = {
    kind: "call",
    name: "hub widget call",
    command: ["hub", "widget", "call"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "widget", "call"],
            positionals: 0,
            flags: { "--input": "value" },
        });
        const path = parsed && stringFlag(parsed, "--input");
        if (!path?.startsWith("/")) {
            return null;
        }

        try {
            const input: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
            const action = actionOf(input);
            return action && DOOR_ACTIONS.has(action) ? input : null;
        } catch (error) {
            // An unreadable request: the process prints the CLI's own error.
            log.debug({ error, path }, "hub server: widget call request unreadable; the process answers");
            return null;
        }
    },
    async run(input, { signal }) {
        try {
            signal.throwIfAborted();
            const { performWidgetAction } = await import("../../lib/widget/actions");
            const result = await performWidgetAction({ input, signal });
            return ok(asResult(result ?? { ok: true }));
        } catch (error) {
            return failed(error);
        }
    },
};

interface ContextArgs {
    id: string;
    key: string;
    before: number;
    after: number;
}

/** `hub widget context <id> --key <key> [--before N] [--after N] [--json]`: a decision card's nearby transcript. */
export const widgetContextDoor: CallDoor<ContextArgs> = {
    kind: "call",
    name: "hub widget context",
    command: ["hub", "widget", "context"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "widget", "context"],
            positionals: 1,
            flags: { "--key": "value", "--before": "value", "--after": "value", "--json": "bool" },
        });
        const key = parsed && stringFlag(parsed, "--key");
        if (!parsed || !key) {
            return null;
        }

        // The CLI's defaults; a count outside 0-10 stays a process, which prints the lib's own error.
        const before = parsed.flags.has("--before") ? wholeNumber(parsed.flags.get("--before")) : 2;
        const after = parsed.flags.has("--after") ? wholeNumber(parsed.flags.get("--after")) : 2;
        if (before === null || after === null || before > 10 || after > 10) {
            return null;
        }

        return { id: parsed.positionals[0], key, before, after };
    },
    async run(args, { signal }) {
        try {
            signal.throwIfAborted();
            const { readWidgetReceiptContext } = await import("../../lib/widget/context");
            return ok(asResult(await readWidgetReceiptContext({ ...args, signal })));
        } catch (error) {
            return failed(error);
        }
    },
};

type TasksListArgs = Partial<WidgetTaskFilters> & Pick<WidgetTaskFilters, "scope" | "limit">;

/**
 * `hub widget tasks list [--json] --scope <scope> [--limit N] [--project P] [--session S]`: the widget's Tasks module
 * (one process per decision-log write before this door). One `--project` and one `--session` value, as the widget
 * sends them; a longer list stays a process.
 */
export const widgetTasksListDoor: CallDoor<TasksListArgs> = {
    kind: "call",
    name: "hub widget tasks list",
    command: ["hub", "widget", "tasks", "list"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "widget", "tasks", "list"],
            positionals: 0,
            flags: {
                "--json": "bool",
                "--scope": "value",
                "--limit": "value",
                "--project": "value",
                "--session": "value",
            },
        });
        const given = parsed && stringFlag(parsed, "--scope");
        const scope = WIDGET_TASK_SCOPES.find((item) => item === given);
        if (!parsed || !scope) {
            return null;
        }

        const limit = parsed.flags.has("--limit") ? wholeNumber(parsed.flags.get("--limit")) : 200;
        if (limit === null || limit < 1 || limit > 250) {
            return null;
        }

        const project = stringFlag(parsed, "--project");
        const session = stringFlag(parsed, "--session");
        return {
            scope,
            limit,
            ...(project === undefined ? {} : { projects: [project] }),
            ...(session === undefined ? {} : { sessions: [session] }),
        };
    },
    async run(filters, { signal }) {
        try {
            signal.throwIfAborted();
            const { listWidgetTasks } = await import("../../lib/widget/tasks");
            return ok(asResult(listWidgetTasks({ filters, signal })));
        } catch (error) {
            return failed(error);
        }
    },
};
