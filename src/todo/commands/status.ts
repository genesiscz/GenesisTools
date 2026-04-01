import { isInteractive } from "@app/utils/cli";
import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat } from "@app/todo/lib/types";
import { Command } from "commander";

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
}

function resolveProjectRoot(): string {
    return findProjectRoot(process.cwd()) ?? process.cwd();
}

export function createStartCommand(): Command {
    return new Command("start")
        .description("Mark a todo as in-progress")
        .argument("<id>", "Todo ID")
        .option("-f, --format <format>", "Output format")
        .action(async (id, opts) => {
            const store = TodoStore.forProject(resolveProjectRoot());
            const todo = await store.update(id, { status: "in-progress" });
            console.log(formatTodo(todo, resolveFormat(opts.format)));
        });
}

export function createBlockCommand(): Command {
    return new Command("block")
        .description("Mark a todo as blocked")
        .argument("<id>", "Todo ID")
        .option("-f, --format <format>", "Output format")
        .action(async (id, opts) => {
            const store = TodoStore.forProject(resolveProjectRoot());
            const todo = await store.update(id, { status: "blocked" });
            console.log(formatTodo(todo, resolveFormat(opts.format)));
        });
}

export function createCompleteCommand(): Command {
    return new Command("complete")
        .alias("done")
        .description("Mark a todo as completed")
        .argument("<id>", "Todo ID")
        .option("-n, --note <text>", "Completion note")
        .option("-f, --format <format>", "Output format")
        .action(async (id, opts) => {
            const store = TodoStore.forProject(resolveProjectRoot());
            const todo = await store.complete(id, opts.note);
            console.log(formatTodo(todo, resolveFormat(opts.format)));
        });
}

export function createReopenCommand(): Command {
    return new Command("reopen")
        .description("Reopen a completed todo")
        .argument("<id>", "Todo ID")
        .option("-f, --format <format>", "Output format")
        .action(async (id, opts) => {
            const store = TodoStore.forProject(resolveProjectRoot());
            const todo = await store.update(id, {
                status: "todo",
                completedAt: undefined,
                completionNote: undefined,
            });
            console.log(formatTodo(todo, resolveFormat(opts.format)));
        });
}
