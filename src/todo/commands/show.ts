import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat } from "@app/todo/lib/types";
import { isInteractive } from "@app/utils/cli";
import { Command } from "commander";

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
}

export function createShowCommand(): Command {
    return new Command("show")
        .description("Show a single todo in detail")
        .argument("<id>", "Todo ID")
        .option("-f, --format <format>", "Output format: ai|json|md|table")
        .option("--colors", "Force colorized output even in non-TTY")
        .action(async (id, opts) => {
            const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
            const store = TodoStore.forProject(projectRoot);
            let todo = await store.get(id);

            if (!todo) {
                const allTodos = await TodoStore.listAll();
                todo = allTodos.find((t) => t.id === id) ?? null;
            }

            if (!todo) {
                console.error(`Todo not found: ${id}`);
                process.exit(1);
            }

            const format = resolveFormat(opts.format);
            console.log(formatTodo(todo, format, { colors: opts.colors }));
        });
}
