import {
    EVENT_CATEGORIES,
    type EventSelection,
    POPULAR_EVENTS,
    resolveEventSelection,
    type SupportedEvents,
    splitNames,
    supportedEvents,
} from "@app/macos/lib/eslogger/events";
import { compileFilter, type EventFilter, FILTER_EXAMPLE, FilterSyntaxError } from "@app/macos/lib/eslogger/filter";
import { shellQuote } from "@app/macos/lib/eslogger/format";
import {
    classifyStderr,
    esloggerInvocation,
    explainStderr,
    listEventsFromEslogger,
    replayInput,
    rootRequiredMessage,
    runLiveCapture,
    type StderrKind,
} from "@app/macos/lib/eslogger/run";
import { EventStream } from "@app/macos/lib/eslogger/stream";
import { formatMissingEnumHelp, isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { fullDiskAccessSubject } from "@genesiscz/utils/macos/full-disk-access";
import { cancelSymbol, searchMultiselect } from "@genesiscz/utils/prompts/clack/search-multiselect";
import * as p from "@genesiscz/utils/prompts/p";
import { Command } from "commander";

interface EsloggerOptions {
    events?: string | true;
    category?: string | true;
    includeFork?: boolean;
    filterEvent?: string[];
    output?: string;
    input?: string;
    silent?: boolean;
    dryRun?: boolean;
    debug?: boolean;
    listEvents?: boolean;
}

/** suggestCommand rebuilds the rest (`eslogger -e …`) from argv. */
const TOOL = "tools macos";

type EnumFlag = "--events" | "--category";

const ENUM_FLAGS: Record<EnumFlag, { short: string; example: string }> = {
    "--events": { short: "-e", example: "exec" },
    "--category": { short: "-c", example: "process" },
};

/** The possible values plus the same command with the flag fixed, for a missing or unknown value. */
function enumHelp(flag: EnumFlag, values: readonly string[], given?: string): string {
    const { short, example } = ENUM_FLAGS[flag];
    return formatMissingEnumHelp({
        flag,
        values,
        given,
        suggestion: suggestCommand(TOOL, { remove: [flag, short], add: [flag, example] }),
    });
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

const HELP_AFTER = `
Categories (-c): ${Object.keys(EVENT_CATEGORIES).join(", ")}
Popular events: ${POPULAR_EVENTS.join(", ")}
Every event: ${toolCommand("macos eslogger")} --list-events

Requirements:
  eslogger runs as root. From a terminal, sudo asks for your password and only eslogger runs as root.
  The app macOS holds responsible (GenesisTools.app, or your terminal) needs Full Disk Access:
  ${toolCommand("macos permissions open")} --pane full-disk-access

Filters (--filter-event, repeat for AND). eslogger nests each event under its short name:
  .event.exec.target.executable.path =~ "zsh"     the program an exec starts (regex)
  .event.exec.args =~ "--inspect"                  exec arguments, joined with spaces
  .event.fork.child.audit_token.pid == 1234        the pid a fork creates
  .event.open.file.path !~ "^/System/"             the file an open reads or writes
  .event.write.target.path =~ "\\.plist$"            close, write and unlink use .target.path
  .process.executable.path == "/bin/zsh"           the process that caused the event (exact text)
  .process.audit_token.euid == 0                   events from root (works on every eslogger version)
  ==  != compare the whole value as text, =~ !~ test a regular expression.

Examples:
  ${toolCommand("macos eslogger")} -c process
  ${toolCommand("macos eslogger")} -e exec --filter-event '${FILTER_EXAMPLE}'
  ${toolCommand("macos eslogger")} -e open,write -o events.log
  sudo eslogger exec > exec.jsonl; ${toolCommand("macos eslogger")} --input exec.jsonl --filter-event '.event.exec.args =~ "git"'
`;

export function registerEsloggerCommand(program: Command): void {
    const eslogger = new Command("eslogger");

    eslogger
        .description("Watch Endpoint Security events live (process, file, login, ...) through Apple's eslogger")
        .option("-e, --events [list]", "comma-separated events to capture (see --list-events)")
        .option("-c, --category [list]", "comma-separated event categories to capture")
        .option("--include-fork", "add fork events when capturing exec (fork happens before exec)")
        .option("--filter-event <expr>", "keep only events matching a JSON path expression (repeatable)", collect)
        .option("-o, --output <file>", "write the event lines to a file instead of stdout")
        .option("--input <file>", "replay recorded eslogger JSON lines from a file (- for stdin); needs no root")
        .option("-s, --silent", "print only the event lines, no status")
        .option("-d, --dry-run", "show the eslogger command and the events without starting it")
        .option("--debug", "also print each event's raw JSON (to stderr)")
        .option("--list-events", "list the categories and every event this Mac's eslogger supports")
        .addHelpText("after", HELP_AFTER)
        .action(async (options: EsloggerOptions) => {
            await main(options);
        });

    program.addCommand(eslogger);
}

function fail(message: string): void {
    logger.debug({ message }, "eslogger: refused");
    out.printlnErr(message);
    process.exitCode = 1;
}

function isRoot(): boolean {
    return process.getuid?.() === 0;
}

function columns(names: readonly string[], width = 28, perRow = 4): string[] {
    const rows: string[] = [];

    for (let i = 0; i < names.length; i += perRow) {
        rows.push(
            `  ${names
                .slice(i, i + perRow)
                .map((name) => name.padEnd(width))
                .join("")
                .trimEnd()}`
        );
    }

    return rows;
}

function renderEventList(supported: SupportedEvents): void {
    const source =
        supported.source === "eslogger"
            ? "reported by /usr/bin/eslogger on this Mac"
            : "built-in list, eslogger not found";
    const lines = ["Categories (-c)"];

    for (const [name, category] of Object.entries(EVENT_CATEGORIES)) {
        lines.push(`  ${name.padEnd(12)} ${category.events.join(", ")}`);
        lines.push(`  ${"".padEnd(12)} ${category.description}`);
    }

    lines.push("", `Events (-e), ${supported.events.length} ${source}`, ...columns(supported.events));
    out.println(lines.join("\n"));
}

/** `-e`/`-c` given without a value: prompt on a TTY, else print the possible values. */
async function promptForFlag(flag: EnumFlag, supported: readonly string[]): Promise<string[] | null> {
    const values = flag === "--category" ? Object.keys(EVENT_CATEGORIES) : supported;

    if (!isInteractive()) {
        fail(enumHelp(flag, values));
        return null;
    }

    if (flag === "--category") {
        const picked = await p.multiselect({
            message: "Event categories to capture",
            options: Object.entries(EVENT_CATEGORIES).map(([name, category]) => ({
                value: name,
                label: name,
                hint: category.description,
            })),
            required: true,
        });
        return picked.map(String);
    }

    const picked = await searchMultiselect({
        message: "Events to capture (type to filter)",
        items: supported.map((name) => ({ value: name, label: name })),
        initialSelected: ["exec"],
        maxVisible: 14,
    });

    if (picked === cancelSymbol || !Array.isArray(picked)) {
        p.cancel("Cancelled.");
        return null;
    }

    return picked;
}

/** Neither -e nor -c: ask on a TTY, else name the flags. */
async function promptForSelection(
    supported: readonly string[]
): Promise<{ events: string[]; categories: string[] } | null> {
    if (!isInteractive()) {
        fail(
            [
                "Say what to capture: -e <events> or -c <category>.",
                suggestCommand(TOOL, { add: ["-c", "process"] }),
                `Every event and category: ${toolCommand("macos eslogger")} --list-events`,
            ].join("\n")
        );
        return null;
    }

    const mode = String(
        await p.select({
            message: "What should eslogger capture?",
            options: [
                { value: "popular", label: "Popular events", hint: POPULAR_EVENTS.join(", ") },
                { value: "category", label: "Categories", hint: Object.keys(EVENT_CATEGORIES).join(", ") },
                { value: "custom", label: "Pick events", hint: `${supported.length} available` },
            ],
        })
    );

    if (mode === "popular") {
        return { events: [...POPULAR_EVENTS], categories: [] };
    }

    const picked = await promptForFlag(mode === "category" ? "--category" : "--events", supported);

    if (!picked) {
        return null;
    }

    return mode === "category" ? { events: [], categories: picked } : { events: picked, categories: [] };
}

async function chooseEvents(options: EsloggerOptions, supported: readonly string[]): Promise<EventSelection | null> {
    let events = typeof options.events === "string" ? splitNames(options.events) : [];
    let categories = typeof options.category === "string" ? splitNames(options.category) : [];

    if (options.events === true) {
        const picked = await promptForFlag("--events", supported);

        if (!picked) {
            return null;
        }

        events = picked;
    }

    if (options.category === true) {
        const picked = await promptForFlag("--category", supported);

        if (!picked) {
            return null;
        }

        categories = picked;
    }

    if (events.length === 0 && categories.length === 0) {
        if (options.input) {
            return { events: [], unknownEvents: [], unknownCategories: [], skippedEvents: [], addedFork: false };
        }

        const picked = await promptForSelection(supported);

        if (!picked) {
            return null;
        }

        events = picked.events;
        categories = picked.categories;
    }

    const selection = resolveEventSelection({ events, categories, includeFork: options.includeFork, supported });

    if (selection.unknownCategories.length > 0) {
        fail(enumHelp("--category", Object.keys(EVENT_CATEGORIES), selection.unknownCategories.join(",")));
        return null;
    }

    if (selection.unknownEvents.length > 0) {
        fail(enumHelp("--events", supported, selection.unknownEvents.join(",")));
        return null;
    }

    if (selection.skippedEvents.length > 0) {
        ui.warn(
            `This Mac's eslogger has no ${selection.skippedEvents.join(", ")}, so they are left out of the capture.`
        );
    }

    if (selection.events.length === 0) {
        fail(
            `This Mac's eslogger supports none of the events you chose. Every event it supports: ${toolCommand("macos eslogger")} --list-events`
        );
        return null;
    }

    return selection;
}

async function main(options: EsloggerOptions): Promise<void> {
    const supported = supportedEvents(listEventsFromEslogger);
    logger.debug({ source: supported.source, count: supported.events.length }, "eslogger: supported events");

    if (options.listEvents) {
        renderEventList(supported);
        return;
    }

    let filters: EventFilter[];

    try {
        filters = (options.filterEvent ?? []).map((expression) => compileFilter(expression, supported.events));
    } catch (error) {
        if (error instanceof FilterSyntaxError) {
            fail(error.message);
            return;
        }

        throw error;
    }

    const selection = await chooseEvents(options, supported.events);

    if (!selection) {
        return;
    }

    const selected = new Set(selection.events);
    const status = (message: string): void => {
        if (!options.silent) {
            ui.dim(message);
        }
    };

    for (const filter of filters) {
        if (filter.eventName && selected.size > 0 && !selected.has(filter.eventName)) {
            ui.warn(
                `The filter \`${filter.expression}\` reads ${filter.eventName} events, which are not captured, so it never matches.`
            );
        }
    }

    if (options.input && options.input !== "-" && !(await Bun.file(options.input).exists())) {
        fail(`No such file: ${options.input}`);
        return;
    }

    const invocation = esloggerInvocation({ events: selection.events, isRoot: isRoot() });

    if (options.dryRun) {
        out.println(
            [
                options.input
                    ? `Would replay: ${options.input === "-" ? "standard input" : options.input}`
                    : `Would run: ${invocation.argv.map(shellQuote).join(" ")}`,
                selection.events.length > 0
                    ? `Events (${selection.events.length}): ${selection.events.join(", ")}`
                    : "Events: every event in the recording",
                `Filters: ${filters.length > 0 ? filters.map((filter) => filter.expression).join(" AND ") : "none"}`,
                `Output: ${options.output ?? "stdout"}`,
            ].join("\n")
        );
        return;
    }

    const writer = options.output ? Bun.file(options.output).writer() : undefined;
    const stream = new EventStream({
        filters,
        events: options.input && selected.size > 0 ? selected : undefined,
        onEvent: (line) => {
            if (writer) {
                writer.write(`${line}\n`);
                return;
            }

            out.println(line);
        },
        onRaw: options.debug ? (message) => ui.raw(SafeJSON.stringify(message, null, 2)) : undefined,
        onParseError: (error, line, count) => {
            if (count <= 3) {
                ui.warn(`Skipped a line that is not an eslogger event (${error}): ${line.slice(0, 160)}`);
            }
        },
    });

    const finish = async (): Promise<void> => {
        if (writer) {
            await writer.end();
        }

        const { lines, events, shown, parseErrors } = stream.stats;
        logger.debug({ lines, events, shown, parseErrors, output: options.output }, "eslogger: done");
        status(
            `${events} event(s) read, ${shown} shown${parseErrors > 0 ? `, ${parseErrors} line(s) skipped as not JSON` : ""}${options.output ? `, written to ${options.output}` : ""}.`
        );
    };

    if (options.input) {
        await replayInput(options.input, stream);
        await finish();
        return;
    }

    const fdaSubject = fullDiskAccessSubject();

    if (invocation.viaSudo && !isInteractive()) {
        fail(rootRequiredMessage({ command: suggestCommand(TOOL, {}), fdaSubject }));
        return;
    }

    if (selection.addedFork) {
        status("Added fork events (a fork comes before every exec).");
    }

    status(`Capturing ${selection.events.length} event type(s): ${selection.events.join(", ")}`);

    if (selected.has("exec")) {
        status("Shell builtins (cd, echo, zsh's which) never exec. eslogger also hides its own process group.");
    }

    for (const filter of filters) {
        status(`Filter: ${filter.expression}`);
    }

    status(invocation.viaSudo ? "Starting eslogger through sudo. Press Ctrl+C to stop." : "Press Ctrl+C to stop.");

    const explained = new Set<StderrKind>();
    const result = await withInterrupt((signal) =>
        runLiveCapture({
            invocation,
            stream,
            signal,
            onStderrLine: (line) => {
                const kind = classifyStderr(line);
                logger.debug({ kind, line }, "eslogger: stderr");
                const explanation = explainStderr(kind, fdaSubject);

                if (!explanation) {
                    ui.warn(line);
                    return;
                }

                if (!explained.has(kind)) {
                    explained.add(kind);
                    out.printlnErr(explanation);
                }
            },
        })
    );

    await finish();

    if (!result.interrupted && result.exitCode !== 0) {
        if (explained.size === 0) {
            ui.err(
                `eslogger stopped with ${result.signalCode ? `signal ${result.signalCode}` : `exit code ${result.exitCode}`}.`
            );
        }

        process.exitCode = 1;
    }
}
