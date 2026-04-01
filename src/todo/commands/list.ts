import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodoList } from "@app/todo/lib/format";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat, Todo, TodoFilters, TodoPriority, TodoStatus } from "@app/todo/lib/types";
import { isInteractive } from "@app/utils/cli";
import { Command } from "commander";

const ACTIVE_STATUSES: TodoStatus[] = ["todo", "in-progress", "blocked"];

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "table" : "ai";
}

export function createListCommand(): Command {
    return new Command("list")
        .alias("ls")
        .description("List todos")
        .option("--all", "List across all projects")
        .option("--status <statuses>", "Filter by status (comma-separated)")
        .option("--priority <priorities>", "Filter by priority (comma-separated)")
        .option("--tag <tags>", "Filter by tags (comma-separated)")
        .option("--session <id>", "Filter by session ID")
        .option("-f, --format <format>", "Output format: ai|json|md|table")
        .action(async (opts) => {
            const filters: TodoFilters = {};

            if (opts.status) {
                filters.status = opts.status.split(",").map((s: string) => s.trim()) as TodoStatus[];
            } else {
                filters.status = ACTIVE_STATUSES;
            }

            if (opts.priority) {
                filters.priority = opts.priority.split(",").map((s: string) => s.trim()) as TodoPriority[];
            }

            if (opts.tag) {
                filters.tags = opts.tag.split(",").map((s: string) => s.trim());
            }

            if (opts.session) {
                filters.sessionId = opts.session;
            }

            let todos: Todo[];

            if (opts.all) {
                todos = await TodoStore.listAll(filters);
            } else {
                const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
                const store = TodoStore.forProject(projectRoot);
                todos = await store.list(filters);
            }

            const format = resolveFormat(opts.format);
            console.log(formatTodoList(todos, format));
        });
}
