import { formatTodo } from "@app/todo/lib/format";
import {
    PROJECT_OPTION_DESCRIPTION,
    reportMissingTodo,
    resolveProjectRoot,
    storeForProject,
    UNRECORDED_ROOT,
} from "@app/todo/lib/project";
import type { OutputFormat } from "@app/todo/lib/types";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command, Option } from "commander";
import pc from "picocolors";

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
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .addOption(new Option("-f, --format <format>", "Output format").choices(["ai", "json", "md", "table"]))
        .option("--colors", "Force colorized output even in non-TTY")
        .action(async (id, opts) => {
            const projectRoot = resolveProjectRoot(opts.project);
            const store = storeForProject(opts.project);
            let todo = await store.get(id);

            if (!todo) {
                // Reading is harmless across projects, so `show` still answers — but it
                // says where the todo actually lives, because every MUTATING command
                // needs that `--project` to reach the same record.
                const missing = await reportMissingTodo(id, projectRoot);

                if (!missing.found) {
                    out.error(pc.red(missing.message));

                    process.exit(1);
                }

                todo = missing.found.todo;
                logger.debug(
                    { id, projectRoot, owner: missing.found.projectRoot },
                    "todo show fell back cross-project"
                );
                out.error(pc.yellow(`Note: ${id} belongs to ${missing.found.projectRoot || UNRECORDED_ROOT}.`));

                if (missing.found.projectRoot) {
                    out.error(
                        pc.yellow(`      Pass --project ${missing.found.projectRoot} to edit, sync or complete it.`)
                    );
                }
            }

            const format = resolveFormat(opts.format);
            out.println(formatTodo(todo, format, { colors: opts.colors }));
        });
}
