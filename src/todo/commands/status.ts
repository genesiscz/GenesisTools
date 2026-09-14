import { formatTodo } from "@app/todo/lib/format";
import {
    PROJECT_OPTION_DESCRIPTION,
    reportMissingTodo,
    resolveProjectRoot,
    storeForProject,
} from "@app/todo/lib/project";
import type { OutputFormat, Todo } from "@app/todo/lib/types";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
}

/**
 * A status change against an id the cwd's project does not hold used to surface
 * as a bare "Todo not found" thrown from the store. It now names the project
 * that owns the id and the command to re-run.
 */
async function mutateStatus(
    id: string,
    projectFlag: string | undefined,
    patch: (store: ReturnType<typeof storeForProject>) => Promise<Todo>
): Promise<Todo> {
    const store = storeForProject(projectFlag);
    const existing = await store.get(id);

    if (!existing) {
        const missing = await reportMissingTodo(id, resolveProjectRoot(projectFlag));

        out.error(pc.red(missing.message));

        process.exit(1);
    }

    return patch(store);
}

function statusCommand(options: {
    name: string;
    alias?: string;
    description: string;
    apply: (store: ReturnType<typeof storeForProject>, id: string, opts: { note?: string }) => Promise<Todo>;
    withNote?: boolean;
}): Command {
    const command = new Command(options.name)
        .description(options.description)
        .argument("<id>", "Todo ID")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("-f, --format <format>", "Output format")
        .option("--colors", "Force colorized output even in non-TTY");

    if (options.alias) {
        command.alias(options.alias);
    }

    if (options.withNote) {
        command.option("-n, --note <text>", "Completion note");
    }

    return command.action(async (id, opts) => {
        const todo = await mutateStatus(id, opts.project, (store) => options.apply(store, id, opts));
        out.println(formatTodo(todo, resolveFormat(opts.format), { colors: opts.colors }));
    });
}

export function createStartCommand(): Command {
    return statusCommand({
        name: "start",
        description: "Mark a todo as in-progress",
        apply: (store, id) => store.update(id, { status: "in-progress" }),
    });
}

export function createBlockCommand(): Command {
    return statusCommand({
        name: "block",
        description: "Mark a todo as blocked",
        apply: (store, id) => store.update(id, { status: "blocked" }),
    });
}

export function createCompleteCommand(): Command {
    return statusCommand({
        name: "complete",
        alias: "done",
        description: "Mark a todo as completed",
        withNote: true,
        apply: (store, id, opts) => store.complete(id, opts.note),
    });
}

export function createReopenCommand(): Command {
    return statusCommand({
        name: "reopen",
        description: "Reopen a completed todo",
        apply: (store, id) =>
            store.update(id, {
                status: "todo",
                completedAt: undefined,
                completionNote: undefined,
            }),
    });
}
