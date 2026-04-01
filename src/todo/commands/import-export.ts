import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectRoot } from "@app/todo/lib/context";
import { TodoStore } from "@app/todo/lib/store";
import type { Todo } from "@app/todo/lib/types";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";

const REQUIRED_FIELDS = ["id", "title", "status"] as const;

function validateTodos(data: unknown): Todo[] {
    if (!Array.isArray(data)) {
        throw new Error("Import file must contain a JSON array of todos");
    }

    for (let i = 0; i < data.length; i++) {
        const item = data[i];

        if (typeof item !== "object" || item === null) {
            throw new Error(`Item at index ${i} is not an object`);
        }

        for (const field of REQUIRED_FIELDS) {
            if (!(field in item)) {
                throw new Error(`Item at index ${i} is missing required field: ${field}`);
            }
        }
    }

    return data as Todo[];
}

export function createExportCommand(): Command {
    return new Command("export")
        .description("Export todos as JSON")
        .option("--all", "Export across all projects")
        .option("-o, --output <file>", "Write to file instead of stdout")
        .action(async (opts) => {
            let todos: Todo[];

            if (opts.all) {
                todos = await TodoStore.listAll();
            } else {
                const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
                const store = TodoStore.forProject(projectRoot);
                todos = await store.list();
            }

            const output = SafeJSON.stringify(todos, null, 2);

            if (opts.output) {
                const outPath = resolve(opts.output);
                await Bun.write(outPath, output);
                console.error(`Exported ${todos.length} todo(s) to ${outPath}`);
            } else {
                console.log(output);
            }
        });
}

export function createImportCommand(): Command {
    return new Command("import")
        .description("Import todos from a JSON file")
        .argument("<file>", "JSON file to import")
        .option("--project <path>", "Override project root")
        .action(async (file, opts) => {
            const filePath = resolve(file);

            if (!existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                process.exit(1);
            }

            const content = await Bun.file(filePath).text();
            let parsed: unknown;

            try {
                parsed = SafeJSON.parse(content);
            } catch {
                console.error("Failed to parse JSON from file");
                process.exit(1);
            }

            const todos = validateTodos(parsed);
            const projectRoot = opts.project
                ? resolve(opts.project)
                : (findProjectRoot(process.cwd()) ?? process.cwd());
            const store = TodoStore.forProject(projectRoot);
            const count = await store.bulkImport(todos);

            console.log(`Imported ${count} todo(s)`);
        });
}
