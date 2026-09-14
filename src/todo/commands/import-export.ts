import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_OPTION_DESCRIPTION, storeForProject } from "@app/todo/lib/project";
import { TodoStore } from "@app/todo/lib/store";
import type { Todo } from "@app/todo/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";

// Must match required fields in Todo (src/todo/lib/types.ts)
const REQUIRED_FIELDS = ["id", "title", "status", "priority", "tags", "context"] as const;

function validateTodos(data: unknown): Todo[] {
    if (!Array.isArray(data)) {
        throw new Error("Import file must contain a JSON array of todos");
    }

    for (let i = 0; i < data.length; i++) {
        const item = data[i] as Record<string, unknown>;

        if (typeof item !== "object" || item === null) {
            throw new Error(`Item at index ${i} is not an object`);
        }

        for (const field of REQUIRED_FIELDS) {
            if (!(field in item)) {
                throw new Error(`Item at index ${i} is missing required field: ${field}`);
            }
        }

        // Default optional arrays to prevent runtime crashes
        item.attachments ??= [];
        item.links ??= [];
        item.reminders ??= [];
        item.tags ??= [];
    }

    return data as Todo[];
}

export function createExportCommand(): Command {
    return new Command("export")
        .description("Export todos as JSON")
        .option("--all", "Export across all projects")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("-o, --output <file>", "Write to file instead of stdout")
        .action(async (opts) => {
            let todos: Todo[];

            if (opts.all) {
                todos = await TodoStore.listAll();
            } else {
                todos = await storeForProject(opts.project).list();
            }

            const output = SafeJSON.stringify(todos, null, 2);

            if (opts.output) {
                const outPath = resolve(opts.output);
                await Bun.write(outPath, output);
                out.error(`Exported ${todos.length} todo(s) to ${outPath}`);
            } else {
                out.println(output);
            }
        });
}

export function createImportCommand(): Command {
    return new Command("import")
        .description("Import todos from a JSON file")
        .argument("<file>", "JSON file to import")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .action(async (file, opts) => {
            const filePath = resolve(file);

            if (!existsSync(filePath)) {
                out.error(`File not found: ${filePath}`);
                process.exit(1);
            }

            const content = await Bun.file(filePath).text();
            let parsed: unknown;

            try {
                parsed = SafeJSON.parse(content);
            } catch {
                out.error("Failed to parse JSON from file");
                process.exit(1);
            }

            const todos = validateTodos(parsed);
            const count = await storeForProject(opts.project).bulkImport(todos);

            out.println(`Imported ${count} todo(s)`);
        });
}
