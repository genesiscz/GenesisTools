import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { parseLinks } from "@app/todo/lib/links";
import { TodoStore } from "@app/todo/lib/store";
import { type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import type { OutputFormat, TodoPriority } from "@app/todo/lib/types";
import { isInteractive, parseVariadic, suggestCommand } from "@app/utils/cli";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const PRIORITIES: TodoPriority[] = ["critical", "high", "medium", "low"];

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
}

function resolveProjectRoot(flag: string | undefined): string {
    if (flag) {
        return flag;
    }

    return findProjectRoot(process.cwd()) ?? process.cwd();
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function createAddCommand(): Command {
    return new Command("add")
        .description("Add a new todo")
        .argument("[title]", "Todo title")
        .option("-d, --description <text>", "Description text")
        .option("-p, --priority <priority>", "Priority: critical|high|medium|low")
        .option("-t, --tag <tags>", "Comma-separated tags")
        .option("-r, --reminder <time>", "Reminder time (repeatable)", collect, [])
        .option("-l, --link <link>", "Link (repeatable): pr:123, issue:456, ado:789, URL", collect, [])
        .option("-s, --session-id <id>", "Session ID for tracking")
        .option("-a, --attach <path>", "File path to attach (repeatable)", collect, [])
        .option("--md <path>", "Markdown file to inline as content")
        .option("--project <path>", "Override project root")
        .option("--sync-to <target>", "Auto-sync reminders: calendar|reminders|both")
        .option("-f, --format <format>", "Output format: ai|json|md|table")
        .option("--colors", "Force colorized output even in non-TTY")
        .action(async (titleArg, opts) => {
            let title: string | undefined = titleArg;
            let priority: TodoPriority | undefined = opts.priority;
            let tags: string[] | undefined = opts.tag ? parseVariadic(opts.tag) : undefined;
            let description: string | undefined = opts.description;

            if (!title && !isInteractive()) {
                console.error("Error: title is required in non-interactive mode.");
                console.error(suggestCommand("tools todo add", { add: ['"My todo title"'] }));
                process.exit(1);
            }

            if (isInteractive()) {
                p.intro(pc.bgCyan(pc.black(" todo add ")));

                if (!title) {
                    const result = await p.text({
                        message: "Title",
                        placeholder: "What needs to be done?",
                        validate: (v) => (!v || v.length === 0 ? "Title is required" : undefined),
                    });

                    if (p.isCancel(result)) {
                        p.cancel("Cancelled.");
                        process.exit(0);
                    }

                    title = result;
                }

                if (!priority) {
                    const result = await p.select({
                        message: "Priority",
                        options: PRIORITIES.map((pr) => ({ value: pr, label: pr })),
                        initialValue: "medium" as TodoPriority,
                    });

                    if (p.isCancel(result)) {
                        p.cancel("Cancelled.");
                        process.exit(0);
                    }

                    priority = result;
                }

                if (!tags) {
                    const result = await p.text({
                        message: "Tags (comma-separated, optional)",
                        placeholder: "e.g. auth, backend",
                    });

                    if (p.isCancel(result)) {
                        p.cancel("Cancelled.");
                        process.exit(0);
                    }

                    if (result) {
                        tags = parseVariadic(result);
                    }
                }

                if (!description) {
                    const result = await p.text({
                        message: "Description (optional)",
                        placeholder: "Additional details...",
                    });

                    if (p.isCancel(result)) {
                        p.cancel("Cancelled.");
                        process.exit(0);
                    }

                    if (result) {
                        description = result;
                    }
                }
            }

            const projectRoot = resolveProjectRoot(opts.project);
            const store = TodoStore.forProject(projectRoot);
            const reminders = parseVariadic(opts.reminder);
            const linkInputs = parseVariadic(opts.link);
            const links = linkInputs.length > 0 ? parseLinks(linkInputs) : undefined;
            const attachFiles = parseVariadic(opts.attach);

            const todo = await store.add({
                title: title!,
                description,
                priority,
                tags,
                links,
                reminders: reminders.length > 0 ? reminders : undefined,
                sessionId: opts.sessionId,
                attachFiles: attachFiles.length > 0 ? attachFiles : undefined,
                mdFile: opts.md,
            });

            const format = resolveFormat(opts.format);
            console.log(formatTodo(todo, format, { colors: opts.colors }));

            if (opts.syncTo && todo.reminders.length > 0) {
                const target = opts.syncTo as SyncTarget;
                const count = await syncTodo({ store, todo, target });

                if (count > 0) {
                    console.error(pc.green(`Synced ${count} reminder(s) to ${target}.`));
                }
            }

            if (isInteractive()) {
                p.log.success(`Created ${todo.id}`);
                p.outro("Done!");
            }
        });
}
