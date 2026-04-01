import { isInteractive } from "@app/utils/cli";
import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodoList } from "@app/todo/lib/format";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat, Todo } from "@app/todo/lib/types";
import { Command } from "commander";

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "table" : "ai";
}

export function createSearchCommand(): Command {
    return new Command("search")
        .description("Search todos by text")
        .argument("<query>", "Search query")
        .option("--all", "Search across all projects")
        .option("-f, --format <format>", "Output format: ai|json|md|table")
        .action(async (query, opts) => {
            let todos: Todo[];

            if (opts.all) {
                todos = await TodoStore.listAll({ search: query });
            } else {
                const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
                const store = TodoStore.forProject(projectRoot);
                todos = await store.search(query);
            }

            const format = resolveFormat(opts.format);
            console.log(formatTodoList(todos, format));
        });
}
