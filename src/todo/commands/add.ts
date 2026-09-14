import { defaultSessionId } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { parseLinks } from "@app/todo/lib/links";
import { PROJECT_OPTION_DESCRIPTION, resolveProjectRoot } from "@app/todo/lib/project";
import { parseReminderTime } from "@app/todo/lib/reminders";
import { TodoStore } from "@app/todo/lib/store";
import { buildSyncReport, type SyncReport, type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import type { OutputFormat, TodoPriority } from "@app/todo/lib/types";
import * as p from "@clack/prompts";
import { isInteractive, parseVariadic, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command, Option } from "commander";
import pc from "picocolors";

const PRIORITIES: TodoPriority[] = ["critical", "high", "medium", "low"];

export const TIMING_HELP = `
Timing and sync:
  --at <datetime>       The event START time. One todo is one calendar event, so three
                        wall-clock slots need three todos with one --at each.
  --reminder <time>     An ALERT on that event (repeatable). Each one becomes an alarm
                        fired before --at. With no --at, the latest reminder is the start.
                        With no --reminder, one alert is placed at the event start.
  --sync-to <target>    Write the todo to Apple Calendar (an event), Reminders.app (an
                        item), or both. Prints SYNC_OK <target> <id> <verb> <eventId> on
                        stdout, or SYNC_FAILED on stderr with a non-zero exit. Under
                        -f json that line is omitted, so stdout stays one parseable
                        record — read reminders[].syncId from it instead.
  --calendar <name>     Calendar to create the event in (default: GenesisTools).
  --project <path>      The store is keyed by project root, so an id created here is not
                        visible from another cwd. Pass the same --project to every later
                        command for this todo.

Times accept '30m', '24h', '3d', '1w', '2026-04-02 10:00' (local) or a full ISO string.
Verify with: tools todo show <id> -f json  and  tools macos calendar search "<title>"
`;

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
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
        .option("-r, --reminder <time>", "Alert time on the event (repeatable)", collect, [])
        .option("--at <datetime>", "Event START time (ISO datetime, '2026-04-02 10:00', or relative like '3h')")
        .option("-l, --link <link>", "Link (repeatable): pr:123, issue:456, ado:789, URL", collect, [])
        .option("-s, --session-id <id>", "Session ID for tracking (default: the current agent session)")
        .option("-a, --attach <path>", "File path to attach (repeatable)", collect, [])
        .option("--md <path>", "Markdown file to inline as content")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("--calendar <name>", "Calendar to create the event in (default: GenesisTools)")
        .addOption(
            new Option("--sync-to <target>", "Create the Apple Calendar event / Reminders item now").choices([
                "calendar",
                "reminders",
                "both",
            ])
        )
        .addOption(new Option("-f, --format <format>", "Output format").choices(["ai", "json", "md", "table"]))
        .option("--colors", "Force colorized output even in non-TTY")
        .addHelpText("after", TIMING_HELP)
        .action(async (titleArg, opts) => {
            let title: string | undefined = titleArg;
            let priority: TodoPriority | undefined = opts.priority;
            let tags: string[] | undefined = opts.tag ? parseVariadic(opts.tag) : undefined;
            let description: string | undefined = opts.description;

            if (!title && !isInteractive()) {
                out.error("Error: title is required in non-interactive mode.");
                out.error(suggestCommand("tools todo add", { add: ['"My todo title"'] }));
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

            const at = opts.at ? parseReminderTime(opts.at) : undefined;

            let todo = await store.add({
                title: title!,
                description,
                priority,
                tags,
                links,
                reminders: reminders.length > 0 ? reminders : undefined,
                at,
                sessionId: defaultSessionId(opts.sessionId),
                attachFiles: attachFiles.length > 0 ? attachFiles : undefined,
                mdFile: opts.md,
            });

            let report: SyncReport | undefined;

            // Sync BEFORE printing: the printed record is the machine result, and a
            // caller reading `-f json` needs the event id inside it, not on a line
            // that arrived after the JSON.
            if (opts.syncTo) {
                const target = opts.syncTo as SyncTarget;
                const result = await syncTodo({ store, todo, target, calendarName: opts.calendar });
                report = buildSyncReport(result, todo.id);
                todo = (await store.get(todo.id)) ?? todo;
            }

            const format = resolveFormat(opts.format);
            out.println(formatTodo(todo, format, { colors: opts.colors }));

            if (report) {
                // The record printed above already carries `syncId`, so repeating it
                // as a SYNC_OK line would leave `-f json` stdout unparseable — which
                // is exactly what this tool promises it stays.
                if (format !== "json") {
                    for (const line of report.stdout) {
                        out.println(line);
                    }
                }

                for (const line of report.stderr) {
                    out.error(pc.red(line));
                }

                if (report.failed) {
                    process.exitCode = 1;
                }
            }

            if (isInteractive()) {
                p.log.success(`Created ${todo.id}`);
                p.outro("Done!");
            }
        });
}
