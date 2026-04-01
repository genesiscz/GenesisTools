import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { parseLinks } from "@app/todo/lib/links";
import { TodoStore } from "@app/todo/lib/store";
import type { OutputFormat, TodoPriority } from "@app/todo/lib/types";
import { isInteractive, suggestCommand } from "@app/utils/cli";
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
        .option("-f, --format <format>", "Output format: ai|json|md|table")
        .action(async (titleArg, opts) => {
            let title: string | undefined = titleArg;
            let priority: TodoPriority | undefined = opts.priority;
            let tags: string[] | undefined = opts.tag ? opts.tag.split(",").map((s: string) => s.trim()) : undefined;
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
                        tags = result
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
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
            const links = opts.link.length > 0 ? parseLinks(opts.link) : undefined;

            const todo = await store.add({
                title: title!,
                description,
                priority,
                tags,
                links,
                reminders: opts.reminder.length > 0 ? opts.reminder : undefined,
                sessionId: opts.sessionId,
                attachFiles: opts.attach.length > 0 ? opts.attach : undefined,
                mdFile: opts.md,
            });

            const format = resolveFormat(opts.format);
            console.log(formatTodo(todo, format));

            if (isInteractive()) {
                p.log.success(`Created ${todo.id}`);
                p.outro("Done!");
            }
        });
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}
