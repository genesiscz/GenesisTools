import { formatTodoList } from "@app/todo/lib/format";
import { PROJECT_OPTION_DESCRIPTION, storeForProject } from "@app/todo/lib/project";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat, Todo } from "@app/todo/lib/types";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command, Option } from "commander";

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
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .addOption(new Option("-f, --format <format>", "Output format").choices(["ai", "json", "md", "table"]))
        .option("--colors", "Force colorized output even in non-TTY")
        .action(async (query, opts) => {
            let todos: Todo[];

            if (opts.all) {
                todos = await TodoStore.listAll({ search: query });
            } else {
                todos = await storeForProject(opts.project).search(query);
            }

            const format = resolveFormat(opts.format);
            out.println(formatTodoList(todos, format, { colors: opts.colors }));
        });
}
