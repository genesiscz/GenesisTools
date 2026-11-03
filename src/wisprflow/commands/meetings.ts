import { join } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import {
    formatNeedsTimes,
    localTime,
    TRANSCRIPT_FORMATS,
    type TranscriptFormat,
} from "@genesiscz/utils/transcribe/render";
import { type Command, Option } from "commander";
import pc from "picocolors";
import { listLocalMeetings, localAvailable } from "../lib/local";
import { listMcpMeetings, listMcpSeries } from "../lib/mcp";
import { calendarFor } from "../lib/meeting-source";
import { writeGuarded } from "../lib/output";
import {
    meetingFrontmatter,
    type RenderOptions,
    renderMarkdown,
    renderSrt,
    renderText,
    renderVtt,
} from "../lib/render";
import { loadMeeting, resolveMeetingRef } from "../lib/source";
import type { Meeting, MeetingSummary, SourceChoice, SourceName } from "../lib/types";
import { errorText, fail, parseSource, reportSource, resolveEnum, TOOL } from "./shared";

const LIST_FORMATS = ["table", "json"] as const;
const SHOW_FORMATS = ["md", "json", "txt"] as const;
/** Exit code when `-o` would replace a different file and `--confirm` was not given: nothing was written. */
const EXIT_DIFFERS = 2;

interface TranscriptOpts {
    format?: string | boolean;
    output?: string;
    confirm?: boolean;
    frontmatter?: boolean;
    keepFrontmatter?: boolean;
    summary?: boolean;
    timestamps?: boolean;
    firstNames?: boolean;
    source?: string;
    crossCheck?: boolean;
    vocab?: string[];
    minConfidence?: string;
    fixTerm?: string[];
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function printMeetings(rows: MeetingSummary[], source: SourceName): void {
    const table = createBoxTable(["WHEN", "TITLE", "ID", "TRANSCRIPT", "FOLDERS"]);

    for (const row of rows) {
        table.push([
            localTime(row.start),
            pc.white(truncateDisplay(row.title || "(untitled)", 48)),
            pc.dim(row.id),
            row.hasTranscript ? pc.green("yes") : pc.dim("no"),
            truncateDisplay(row.folders.map((f) => f.name).join(", "), 24),
        ]);
    }

    out.println(table.toString());
    ui.dim(`${rows.length} meeting(s) · ${source}`);
    ui.dim(`Next: ${TOOL} meetings transcript <id> --format md`);
}

async function listMeetings(query: string | undefined, opts: Record<string, unknown>): Promise<void> {
    const source = parseSource(opts.source, ["meetings", "list"]);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: LIST_FORMATS,
        flag: "--format",
        subcommand: ["meetings", "list"],
    });

    if (!source || !format) {
        return;
    }

    const filter = {
        query,
        since: opts.since as string | undefined,
        until: opts.until as string | undefined,
        folder: opts.folder as string | undefined,
        limit: Number(opts.limit ?? 25),
    };
    const attendees = opts.attendee as string[] | undefined;
    // The local database has no attendee e-mails, so an attendee filter always asks the MCP.
    const useLocal = source === "local" || (source === "auto" && localAvailable() && !attendees?.length);
    let rows: MeetingSummary[];

    try {
        rows = useLocal ? listLocalMeetings(filter) : await listMcpMeetings({ ...filter, attendees });
    } catch (err) {
        fail(errorText(err));
        return;
    }

    const used: SourceName = useLocal ? "local" : "mcp";
    reportSource(used, filter.folder && !useLocal ? ["--folder only filters local data; ignored by the MCP."] : []);

    if (format === "json") {
        out.result(SafeJSON.stringify({ source: used, meetings: rows }, null, 2));
        return;
    }

    printMeetings(rows, used);
}

/**
 * `tools wisprflow` is the Wispr Flow source and its raw export; term fixes, speaker statistics and attendance are
 * `tools meetings`, which polishes every source in one pipeline. A flag of the old polishing names those commands.
 */
function polishingMoved(what: string, sourceMeetingId: string, next: string[]): void {
    fail(
        [
            `${what} moved to ${toolCommand("meetings")}, which polishes every source's transcript in one pipeline:`,
            `  ${toolCommand("meetings", "new", "--source", `wisprflow:${sourceMeetingId}`)}`,
            ...next.map((command) => `  ${command}`),
        ].join("\n")
    );
}

function render(
    meeting: Meeting,
    format: TranscriptFormat,
    options: RenderOptions,
    extra: Record<string, unknown>
): string {
    switch (format) {
        case "md":
            return renderMarkdown(meeting, options);
        case "txt":
            return renderText(meeting, options);
        case "srt":
            return renderSrt(meeting, options);
        case "vtt":
            return renderVtt(meeting, options);
        case "json":
            return `${SafeJSON.stringify({ source: options.source, ...extra, meeting }, null, 2)}\n`;
    }
}

/** Writes to `-o` through the guard, or prints to stdout. Returns false when nothing was written. */
function deliver(content: string, opts: { output?: string; confirm?: boolean; keepFrontmatter: boolean }): boolean {
    if (!opts.output) {
        out.print(content);
        return true;
    }

    const result = writeGuarded({
        path: opts.output,
        content,
        confirm: opts.confirm === true,
        keepFrontmatter: opts.keepFrontmatter,
    });

    if (result.status === "differs") {
        process.stderr.write(`${result.diff}\n`);
        ui.warn(`${result.path} differs from what this run produces (diff above). Nothing was written.`);
        ui.info(`To replace it: ${suggestCommand(TOOL, { remove: ["--confirm"], add: ["--confirm"] })}`);
        process.exitCode = EXIT_DIFFERS;
        return false;
    }

    ui.ok(`${result.status}: ${result.path}`);
    return true;
}

async function transcript(ref: string, opts: TranscriptOpts): Promise<void> {
    const subcommand = ["meetings", "transcript"];
    const format = await resolveEnum({
        value: opts.format,
        fallback: "md",
        values: TRANSCRIPT_FORMATS,
        flag: "--format",
        subcommand,
    });
    const source = parseSource(opts.source, subcommand);

    if (!format || !source) {
        return;
    }

    let loaded: Awaited<ReturnType<typeof loadMeeting>>;

    try {
        const id = await resolveMeetingRef(ref, source);

        if (opts.fixTerm?.length || opts.vocab?.length || opts.minConfidence !== undefined) {
            polishingMoved("Term fixes", id, [
                toolCommand("meetings", "suggest", `wisprflow:${id}`),
                toolCommand("meetings", "transcript", `wisprflow:${id}`, "--with-suggested"),
            ]);
            return;
        }

        loaded = await loadMeeting(id, { source, transcript: true, crossCheck: opts.crossCheck });
    } catch (err) {
        fail(errorText(err));
        return;
    }

    reportSource(loaded.source, loaded.notes);
    const meeting = loaded.data;

    if (formatNeedsTimes(format) && !meeting.transcript.some((e) => e.startSec !== undefined)) {
        fail(`--format ${format} needs a time per line; only the local source has them (try --source local).`);
        return;
    }

    const options: RenderOptions = {
        source: loaded.source,
        frontmatter: opts.frontmatter !== false,
        summary: opts.summary !== false,
        timestamps: opts.timestamps === true,
        firstNames: opts.firstNames === true,
    };
    deliver(render(meeting, format, options, { notes: loaded.notes }), {
        output: opts.output,
        confirm: opts.confirm,
        keepFrontmatter: format === "md" && opts.keepFrontmatter !== false,
    });
}

function showMarkdown(meeting: Meeting, source: SourceName): string {
    const parts = [
        renderFrontmatter(
            meetingFrontmatter(meeting, {
                source,
                frontmatter: true,
                summary: true,
                timestamps: false,
                firstNames: false,
            })
        ),
        `# ${meeting.title || "Untitled meeting"}`,
    ];
    // Who named each label matters: a platform name is evidence, a language model's name is a guess.
    const people = meeting.participants.map((p) => {
        const speaker = p.speakerId === undefined ? "" : `speaker ${p.speakerId}`;
        const origin = p.origin ? `named by ${p.origin}` : "";
        const notes = [speaker, origin].filter(Boolean).join(", ");
        return `- ${p.name}${p.isSelf ? " (you)" : ""}${notes ? ` (${notes})` : ""}`;
    });

    if (people.length > 0) {
        parts.push("## Participants", people.join("\n"));
    }

    const invited = calendarFor(meeting);

    if (invited && invited.attendees.length > 0) {
        parts.push(
            "## Invited",
            [
                ...invited.attendees.map((name) => `- ${name}`),
                ...(invited.conferenceUrl ? [``, `Call: ${invited.conferenceUrl}`] : []),
            ].join("\n")
        );
    }

    if (meeting.summary.trim()) {
        parts.push("## Summary", meeting.summary.trim());
    }

    if (meeting.notes.trim()) {
        parts.push("## Notes", meeting.notes.trim());
    }

    return `${parts.join("\n\n")}\n`;
}

async function speakers(ref: string, opts: { source?: string }): Promise<void> {
    const source = parseSource(opts.source, ["meetings", "speakers"]);

    if (!source) {
        return;
    }

    try {
        const id = await resolveMeetingRef(ref, source);
        polishingMoved("Speaker statistics and attendance", id, [
            toolCommand("meetings", "speakers", "stats", `wisprflow:${id}`, "--attendance", "teams"),
        ]);
    } catch (err) {
        fail(errorText(err));
    }
}

async function show(ref: string, opts: Record<string, unknown>): Promise<void> {
    const subcommand = ["meetings", "show"];
    const format = await resolveEnum({
        value: opts.format,
        fallback: "md",
        values: SHOW_FORMATS,
        flag: "--format",
        subcommand,
    });
    const source = parseSource(opts.source, subcommand);

    if (!format || !source) {
        return;
    }

    try {
        const id = await resolveMeetingRef(ref, source);
        const loaded = await loadMeeting(id, { source, transcript: false });
        reportSource(loaded.source, loaded.notes);
        const { transcript: _transcript, ...meeting } = loaded.data;

        if (format === "json") {
            out.result(SafeJSON.stringify({ source: loaded.source, notes: loaded.notes, meeting }, null, 2));
        } else if (format === "txt") {
            out.print(
                renderText(
                    { ...loaded.data, transcript: [] },
                    {
                        source: loaded.source,
                        frontmatter: false,
                        summary: true,
                        timestamps: false,
                        firstNames: false,
                    }
                )
            );
        } else {
            out.print(showMarkdown(loaded.data, loaded.source));
        }
    } catch (err) {
        fail(errorText(err));
    }
}

function exportDirName(meeting: Meeting): string {
    const date = localTime(meeting.start).slice(0, 10);
    const title = (meeting.title || meeting.id.slice(0, 8)).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    return `${date}-${title}`;
}

async function exportMeetings(refs: string[], opts: Record<string, unknown>): Promise<void> {
    const source = parseSource(opts.source, ["meetings", "export"]);
    const dir = opts.dir as string;

    if (!source) {
        return;
    }

    for (const ref of refs) {
        try {
            const id = await resolveMeetingRef(ref, source as SourceChoice);
            const loaded = await loadMeeting(id, { source, transcript: true });
            reportSource(loaded.source, loaded.notes);
            const meeting = loaded.data;
            const folder = join(dir, exportDirName(meeting));
            const base: RenderOptions = {
                source: loaded.source,
                frontmatter: true,
                summary: false,
                timestamps: opts.timestamps === true,
                firstNames: opts.firstNames === true,
            };
            const files: Array<[string, string, boolean]> = [
                ["Summary.md", showMarkdown(meeting, loaded.source), true],
                ["Transcript.md", renderMarkdown(meeting, base), true],
                [
                    "meeting.json",
                    `${SafeJSON.stringify({ source: loaded.source, meeting, calendar: calendarFor(meeting) ?? null }, null, 2)}\n`,
                    false,
                ],
            ];

            for (const [name, content, keepFrontmatter] of files) {
                deliver(content, { output: join(folder, name), confirm: opts.confirm === true, keepFrontmatter });
            }
        } catch (err) {
            fail(`${ref}: ${errorText(err)}`);
        }
    }
}

async function series(ref: string, opts: Record<string, unknown>): Promise<void> {
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: LIST_FORMATS,
        flag: "--format",
        subcommand: ["meetings", "series"],
    });

    if (!format) {
        return;
    }

    try {
        const id = await resolveMeetingRef(ref, "mcp");
        const rows = await listMcpSeries(id, Number(opts.limit ?? 25));
        reportSource("mcp");

        if (format === "json") {
            out.result(SafeJSON.stringify({ source: "mcp", meetings: rows }, null, 2));
            return;
        }

        printMeetings(rows, "mcp");
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerMeetingsCommand(program: Command): void {
    const meetings = program.command("meetings").description("Recorded meetings: list, show, transcript, export");

    meetings
        .command("list")
        .alias("ls")
        .argument("[query]", "keyword in title, summary or notes")
        .description("List or search meetings, newest first")
        .option("--since <iso>", "only meetings starting at or after this time")
        .option("--until <iso>", "only meetings starting before this time")
        .option("--folder <name>", "only meetings in a folder (local source)")
        .option("--attendee <email>", "only meetings with this attendee (MCP source)", collect)
        .option("--limit <n>", "how many", "25")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "table | json")
        .action(listMeetings);

    meetings
        .command("show")
        .argument("<meeting>", "meeting id, share link, or share slug")
        .description("One meeting: participants, folders, share link, summary and notes")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "md | json | txt")
        .action(show);

    meetings
        .command("transcript")
        .argument("<meeting>", "meeting id, share link, or share slug")
        .description(
            `Wispr Flow's raw transcript, grouped into speaker turns and paragraphs (polishing: ${toolCommand("meetings")})`
        )
        .option("--format [format]", `${TRANSCRIPT_FORMATS.join(" | ")} (default md)`)
        .option("-o, --output <file>", "write to a file; a different existing file is only replaced with --confirm")
        .option("--confirm", "replace an existing output file that differs")
        .option("--no-frontmatter", "md: omit the frontmatter")
        .option("--no-keep-frontmatter", "md with -o: replace the file's own frontmatter instead of keeping it")
        .option("--no-summary", "omit the summary section")
        .option("--timestamps", "show the start time of each paragraph")
        .option("--first-names", "label speakers by first name")
        .option("--source [source]", "auto | local | mcp")
        .option("--cross-check", "also ask the MCP and report where speaker names differ")
        .addOption(new Option("--no-terms", "no effect: the raw export has no term check").hideHelp())
        .addOption(new Option("--vocab <file>", `moved to ${toolCommand("meetings")}`).argParser(collect).hideHelp())
        .addOption(new Option("--min-confidence <pct>", `moved to ${toolCommand("meetings")}`).hideHelp())
        .addOption(
            new Option("--fix-term <heard::replacement>", `moved to ${toolCommand("meetings")}`)
                .argParser(collect)
                .hideHelp()
        )
        .action(transcript);

    meetings
        .command("speakers")
        .argument("<meeting>", "meeting id, share link, or share slug")
        .description(`Moved: speaker statistics and attendance are ${toolCommand("meetings", "speakers", "stats")}`)
        .addOption(new Option("--gap <duration>").hideHelp())
        .addOption(new Option("--attendance <teams|file>").hideHelp())
        .addOption(new Option("--format [format]").hideHelp())
        .option("--source [source]", "auto | local | mcp")
        .action(speakers);

    meetings
        .command("export")
        .argument("<meetings...>", "meeting ids, share links, or share slugs")
        .description("Write Summary.md, Transcript.md and meeting.json per meeting into a folder")
        .requiredOption("--dir <dir>", "target directory; one sub-folder per meeting")
        .option("--confirm", "replace existing files that differ")
        .option("--timestamps", "show paragraph start times in Transcript.md")
        .option("--first-names", "label speakers by first name")
        .addOption(new Option("--no-terms", "no effect: the raw export has no term check").hideHelp())
        .option("--source [source]", "auto | local | mcp")
        .action(exportMeetings);

    meetings
        .command("series")
        .argument("<meeting>", "a meeting of a recurring series")
        .description("Every recorded occurrence of a recurring meeting (MCP)")
        .option("--limit <n>", "how many", "25")
        .option("--format [format]", "table | json")
        .action(series);
}
