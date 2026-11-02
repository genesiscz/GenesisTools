import { join } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { parseVariadic } from "@genesiscz/utils/cli/variadic";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import {
    formatClock,
    formatNeedsTimes,
    localTime,
    TRANSCRIPT_FORMATS,
    type TranscriptFormat,
} from "@genesiscz/utils/transcribe/render";
import {
    DEFAULT_SPAN_GAP_SEC,
    type Presence,
    type PresenceRange,
    type SpeakerHint,
    speakerStats,
} from "@genesiscz/utils/transcribe/speakers";
import {
    applyFixes,
    buildVocabulary,
    DEFAULT_MIN_CONFIDENCE,
    DEV_GLOSSARY,
    findSuspectTerms,
    fixArg,
    selectFixes,
    type TermFix,
    type TermSuggestion,
    termsFromFile,
    termsFromText,
} from "@genesiscz/utils/transcribe/terms";
import type { Command } from "commander";
import pc from "picocolors";
import { loadPresence } from "../lib/attendance";
import { dictionaryPhrases, listLocalMeetings, localAvailable } from "../lib/local";
import { listMcpMeetings, listMcpSeries } from "../lib/mcp";
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

const { log } = logger.scoped("wisprflow-meetings");

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
    terms?: boolean;
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

function vocabulary(
    meeting: Meeting,
    files: string[] = []
): { vocab: ReturnType<typeof buildVocabulary>; context: ReturnType<typeof termsFromText> } {
    const context = termsFromText(`${meeting.title}\n${meeting.summary}`, "summary");
    let dictionary: string[] = [];

    try {
        dictionary = localAvailable() ? dictionaryPhrases() : [];
    } catch (err) {
        log.warn({ err }, "could not read the Wispr Flow dictionary");
    }

    const vocab = buildVocabulary([
        ...files.map((file) => termsFromFile(file)),
        DEV_GLOSSARY.map((term) => ({ term, source: "glossary" })),
        context,
        dictionary.map((term) => ({ term, source: "dictionary" })),
    ]);
    log.debug({ terms: vocab.length, files }, "built term vocabulary");

    return { vocab, context };
}

function suspectsFor(meeting: Meeting, opts: TranscriptOpts, minConfidence: number): TermSuggestion[] {
    const { vocab, context } = vocabulary(meeting, opts.vocab);
    return findSuspectTerms({ entries: meeting.transcript, vocab, context, minConfidence });
}

function fixCommand(suspects: TermSuggestion[], opts: TranscriptOpts): string | undefined {
    const exact = suspects.filter((s) => s.kind === "exact");

    if (exact.length === 0) {
        return undefined;
    }

    // One explicit pair per suspect, so whoever runs it can drop or edit single pairs. The
    // `--fix-term` values this run already applied stay in argv, so the rerun keeps them.
    const add = exact.flatMap((s) => ["--fix-term", fixArg(s.heard, s.candidates[0]!.term)]);

    // Always last, so the command written into the file is the same on every run.
    if (opts.output) {
        add.push("--confirm");
    }

    return suggestCommand(TOOL, { remove: ["--confirm"], add });
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

    const minConfidence = Number(opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
    let loaded: Awaited<ReturnType<typeof loadMeeting>>;

    try {
        const id = await resolveMeetingRef(ref, source);
        loaded = await loadMeeting(id, { source, transcript: true, crossCheck: opts.crossCheck });
    } catch (err) {
        fail(errorText(err));
        return;
    }

    reportSource(loaded.source, loaded.notes);
    let meeting = loaded.data;

    if (formatNeedsTimes(format) && !meeting.transcript.some((e) => e.startSec !== undefined)) {
        fail(`--format ${format} needs a time per line; only the local source has them (try --source local).`);
        return;
    }

    let fixed: TermFix[] = [];
    let suspects: TermSuggestion[] = [];

    if (opts.terms !== false) {
        suspects = suspectsFor(meeting, opts, minConfidence);

        const specs = parseVariadic(opts.fixTerm);

        if (specs.length > 0) {
            try {
                fixed = selectFixes(specs, suspects, minConfidence);
            } catch (err) {
                fail(errorText(err));
                return;
            }

            const applied = applyFixes(meeting.transcript, fixed);
            meeting = { ...meeting, transcript: applied.entries };
            ui.ok(`applied ${fixed.length} term fix(es), ${applied.replaced} replacement(s)`);
            suspects = suspectsFor(meeting, opts, minConfidence);
        }
    }

    const command = fixCommand(suspects, opts);
    const options: RenderOptions = {
        source: loaded.source,
        frontmatter: opts.frontmatter !== false,
        summary: opts.summary !== false,
        timestamps: opts.timestamps === true,
        firstNames: opts.firstNames === true,
        suspects,
        fixCommand: command,
        fixed,
    };
    const content = render(meeting, format, options, { notes: loaded.notes, suspects, fixed });
    const written = deliver(content, {
        output: opts.output,
        confirm: opts.confirm,
        keepFrontmatter: format === "md" && opts.keepFrontmatter !== false,
    });

    if (written && suspects.length > 0) {
        const where: Record<TranscriptFormat, string> = {
            md: "listed in the callout under the title",
            json: 'listed under "suspects"',
            txt: "see them with --format md",
            srt: "see them with --format md",
            vtt: "see them with --format md",
        };
        ui.info(`${suspects.length} possibly misheard term(s), ${where[format]}.`);

        if (command) {
            ui.info(`To apply them: ${command}`);
        }
    }
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
    const people = meeting.participants.map((p) => `- ${p.name}${p.isSelf ? " (you)" : ""}`);

    if (people.length > 0) {
        parts.push("## Participants", people.join("\n"));
    }

    if (meeting.summary.trim()) {
        parts.push("## Summary", meeting.summary.trim());
    }

    if (meeting.notes.trim()) {
        parts.push("## Notes", meeting.notes.trim());
    }

    return `${parts.join("\n\n")}\n`;
}

const ORIGIN_NOTE: Record<SpeakerHint["strength"], string> = {
    weak: " (the platform named this label: weak)",
    normal: "",
    strong: " (a language model guessed this label: strong)",
};

function rangesText(ranges: PresenceRange[]): string {
    return ranges
        .map((range) => {
            const span =
                range.fromSec === range.toSec
                    ? formatClock(range.fromSec)
                    : `${formatClock(range.fromSec)}–${formatClock(range.toSec)}`;
            const present = range.present ? `, present: ${range.present.join(", ") || "nobody"}` : "";
            return `${span} (${range.lines} ${range.lines === 1 ? "line" : "lines"}${present})`;
        })
        .join("; ");
}

function hintText(hint: SpeakerHint): string {
    if (hint.kind === "absent-speaker") {
        return `${hint.label}: speaks while ${hint.label} was not in the call (Teams attendance), so these lines are someone else: ${rangesText(hint.ranges)}`;
    }

    if (hint.kind === "sole-attendee") {
        const person = hint.self ? `you (${hint.person})` : hint.person;
        return `${hint.label}: only ${person} was in the call (Teams attendance), so these lines are ${person}: ${rangesText(hint.ranges)}`;
    }

    const note = ORIGIN_NOTE[hint.strength];

    if (hint.kind === "several-people") {
        return `${hint.label}: ${hint.spans} spans far apart and ${Math.round(hint.share * 100)} % of the speech, maybe several people${note}`;
    }

    if (hint.kind === "leave-then-continues") {
        const leaves = hint.leaves.map((leave) => {
            const said = `${formatClock(leave.atSec)} "${truncateDisplay(leave.text, 60)}" (speaks again at ${formatClock(leave.continuesAtSec)}`;

            if (leave.echoOf) {
                return `${said}; echoes ${leave.echoOf.label} at ${formatClock(leave.echoOf.atSec)}, so not that person)`;
            }

            return leave.confirmedBy
                ? `${said}; ${leave.confirmedBy} answered the goodbye)`
                : `${said}; nobody answered, maybe only an intention)`;
        });
        const joined = leaves.join("; ");
        return `${hint.label}: says goodbye and keeps speaking, so another voice follows each of: ${joined}${note}`;
    }

    const at = hint.atSec === undefined ? "" : ` at ${formatClock(hint.atSec)}`;
    const spoken = hint.spokenSec > 0 ? `, ${Math.round(hint.spokenSec)} s` : "";
    const join = hint.join ? `; "${hint.join.left}" + "${hint.join.right}" = "${hint.join.joined}"` : "";
    return `${hint.label}: one turn${spoken}${at} next to ${hint.neighbour}, maybe a split voice${join}`;
}

async function speakers(
    ref: string,
    opts: { source?: string; format?: string | boolean; gap?: string; attendance?: string }
): Promise<void> {
    const subcommand = ["meetings", "speakers"];
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: LIST_FORMATS,
        flag: "--format",
        subcommand,
    });
    const source = parseSource(opts.source, subcommand);
    const gapSec = opts.gap === undefined ? DEFAULT_SPAN_GAP_SEC : parseDuration(opts.gap) / 1000;

    if (!format || !source) {
        return;
    }

    if (!(gapSec > 0)) {
        fail(`--gap ${opts.gap} is not a duration (try 90s or 2m).`);
        return;
    }

    let loaded: Awaited<ReturnType<typeof loadMeeting>>;

    try {
        const id = await resolveMeetingRef(ref, source);
        loaded = await loadMeeting(id, { source, transcript: true });
    } catch (err) {
        fail(errorText(err));
        return;
    }

    reportSource(loaded.source, loaded.notes);
    let presence: Presence[] | undefined;

    if (opts.attendance) {
        try {
            const loadedPresence = await loadPresence(loaded.data, opts.attendance);
            presence = loadedPresence.presence;
            ui.dim(loadedPresence.note);
        } catch (err) {
            fail(errorText(err));
            return;
        }
    }

    const stats = speakerStats(loaded.data.transcript, { gapSec, participants: loaded.data.participants, presence });
    log.debug({ meeting: loaded.data.id, speakers: stats.speakers.length, hints: stats.hints.length }, "speaker stats");

    if (format === "json") {
        out.result(SafeJSON.stringify({ meeting: loaded.data.id, source: loaded.source, gapSec, ...stats }, null, 2));
        return;
    }

    const table = createBoxTable([
        "SPEAKER",
        "#",
        "ORIGIN",
        "TURNS",
        "LINES",
        "WORDS",
        "SPOKEN",
        "FIRST–LAST",
        "SPANS",
    ]);

    for (const stat of stats.speakers) {
        const range =
            stat.firstSec === undefined || stat.lastSec === undefined
                ? "—"
                : `${formatClock(stat.firstSec)}–${formatClock(stat.lastSec)}`;
        table.push([
            pc.white(stat.label),
            stat.speakerId === undefined ? "—" : String(stat.speakerId),
            stat.origin === "unknown" ? "—" : stat.origin,
            String(stat.turns),
            String(stat.lines),
            String(stat.words),
            stats.timed ? formatClock(stat.spokenSec) : "—",
            range,
            stat.spans.map((span) => `${formatClock(span.fromSec)}–${formatClock(span.toSec)}`).join(", ") || "—",
        ]);
    }

    out.println(table.toString());

    if (!stats.timed) {
        ui.dim("This source gives no time per line, so only counts are shown (try --source local).");
    }

    for (const hint of stats.hints) {
        if (hint.strength === "weak") {
            ui.dim(hintText(hint));
        } else {
            ui.warn(hintText(hint));
        }
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
            const suspects = opts.terms === false ? [] : suspectsFor(meeting, {}, DEFAULT_MIN_CONFIDENCE);
            const base: RenderOptions = {
                source: loaded.source,
                frontmatter: true,
                summary: false,
                timestamps: opts.timestamps === true,
                firstNames: opts.firstNames === true,
            };
            const files: Array<[string, string, boolean]> = [
                ["Summary.md", showMarkdown(meeting, loaded.source), true],
                ["Transcript.md", renderMarkdown(meeting, { ...base, suspects }), true],
                ["meeting.json", `${SafeJSON.stringify({ source: loaded.source, meeting }, null, 2)}\n`, false],
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
        .description("The transcript, grouped into speaker turns and paragraphs")
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
        .option("--no-terms", "skip the misheard-term check")
        .option("--vocab <file>", "extra vocabulary: a package.json or one term per line (repeatable)", collect)
        .option(
            "--min-confidence <pct>",
            "lowest confidence a suspect term is shown with",
            String(DEFAULT_MIN_CONFIDENCE)
        )
        .option(
            "--fix-term <heard::replacement>",
            'apply one term fix (repeatable): "heard::Replacement", a bare "heard" for its top candidate, or "all"',
            collect
        )
        .action(transcript);

    meetings
        .command("speakers")
        .argument("<meeting>", "meeting id, share link, or share slug")
        .description(
            "Per speaker label: origin, turns, lines, words, spoken time and spans, with hints at mixed or split voices"
        )
        .option("--gap <duration>", "a pause shorter than this keeps two turns in one span", "2m")
        .option(
            "--attendance <teams|file>",
            "who was in the call and when: teams asks tools ms-teams by the meeting title, or a file of its --json output"
        )
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "table | json")
        .action(speakers);

    meetings
        .command("export")
        .argument("<meetings...>", "meeting ids, share links, or share slugs")
        .description("Write Summary.md, Transcript.md and meeting.json per meeting into a folder")
        .requiredOption("--dir <dir>", "target directory; one sub-folder per meeting")
        .option("--confirm", "replace existing files that differ")
        .option("--timestamps", "show paragraph start times in Transcript.md")
        .option("--first-names", "label speakers by first name")
        .option("--no-terms", "skip the misheard-term check")
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
