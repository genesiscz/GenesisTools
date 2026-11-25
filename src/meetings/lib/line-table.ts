import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tsvLine } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingSeats, seatSpan } from "@genesiscz/utils/meetings/seats";
import { formatClock } from "@genesiscz/utils/transcribe/clock";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import { channelEvidence } from "./channel-operation";
import { decisionPeople } from "./from-decisions";
import type { OpenedMeeting } from "./opened-meeting";
import { personInitials } from "./person-initials";
import type { RawMeeting } from "./raw";
import { previewVoices } from "./voices";

/**
 * The line table an agent reads for the speaker pass (`evidence --format tsv`, `pack`): one row per transcript line,
 * every person as a short code that the legend line names, and the full text.
 */
export const LINE_TABLE_COLUMNS = ["idx", "t", "label", "mic", "spk", "voice", "next", "text"] as const;

/** One transcript line as its table cells, keyed by its transcript index (two lines can share a second). */
export type LineTableRow = { idx: number } & Record<Exclude<(typeof LINE_TABLE_COLUMNS)[number], "idx">, string>;

export interface LegendEntry {
    code: string;
    name: string;
    /** "room", "remote" or "remote 00:00–1:10:00" from the saved seats; absent for a name no seat holds. */
    seat?: string;
    self?: boolean;
    /** The person the meeting names this source label as (`set --label`), when it is not the label itself. */
    named?: string;
}

export interface LineTable {
    legend: LegendEntry[];
    rows: LineTableRow[];
    /** Whether the voice and next columns hold the voice labeler's verdicts ("-" in every row when not read). */
    voices: boolean;
}

/** The voice labeler's verdict for one line (`voices preview`): the best person and score, and the runner-up. */
export interface VoiceVerdict {
    index: number;
    person?: string;
    score?: number;
    next?: { person: string; score: number };
}

/** One chunk file of a pack: its name, the first and last line index it holds, and its size. */
export interface PackChunk {
    file: string;
    fromIdx: number;
    toIdx: number;
    rows: number;
    chars: number;
}

export interface PackResult {
    out: string;
    facts: string;
    chunks: PackChunk[];
    rows: number;
    voices: boolean;
}

export const DEFAULT_CHUNK_CHARS = 25_000;
/** A change of label within the chunk size ends a chunk when the chunk holds at least this share of the size. */
const HALF_CHUNK = 0.5;
/** Else the first change of label until a chunk would pass this share of the size ends it. */
const PAST_CHUNK = 1.2;

/** The first letter of each word ("Alice Example" is "AE"), a number word whole ("Speaker 1" is "S1"). */
function initials(name: string): string {
    const code = name
        .split(/[\s._-]+/)
        .filter(Boolean)
        .map((word) => (/^\d+$/.test(word) ? word : (word.match(/\p{L}/u)?.[0] ?? "").toUpperCase()))
        .join("");
    return code || "X";
}

/**
 * The person's seats as the legend prints them. A seat saved with no end stops at the person's recorded leave (a stay
 * with a leave source: a goodbye, the attendance list, a hand edit), so the legend never says "remote 00:01–end" of a
 * person whose stays end at 49:36 (2026-11-25, the P6 pack of the 25.11 call).
 */
function seatOf(seats: MeetingSeats | undefined, name: string, leftAtSec: number | undefined): string | undefined {
    const held: string[] = [];
    for (const side of ["room", "remote"] as const) {
        for (const row of seats?.[side] ?? []) {
            const seat = seatSpan(row);
            if (!sameName(seat.name, name)) {
                continue;
            }

            const toSec = seat.toSec ?? leftAtSec;
            const bounds =
                seat.fromSec !== undefined || toSec !== undefined
                    ? ` ${formatClock(seat.fromSec ?? 0)}–${toSec === undefined ? "end" : formatClock(toSec)}`
                    : "";
            held.push(`${side}${bounds}`);
        }
    }
    return held.length ? held.join(", ") : undefined;
}

/**
 * The codes of a table. The meeting's people come first, with the initials `items from-decisions` reads back
 * (`personInitials`), so a decision that names a legend code lands on that person. Any other name the table shows (a
 * source label, a name the speaking indicator or the voices know) gets its word initials ("Speaker 2" is "S2"), with a
 * lower-case letter when a person's initial or name has them (S2b).
 */
class Legend {
    readonly entries: LegendEntry[] = [];
    private readonly taken = new Set<string>();

    constructor(
        private readonly raw: RawMeeting,
        people: readonly string[],
        private readonly labels: Readonly<Record<string, string>>
    ) {
        for (const [name, code] of personInitials(people)) {
            this.add(name, code);
        }

        for (const name of people) {
            this.taken.add(name.toLowerCase());
        }
    }

    code(name: string): string {
        const known = this.entries.find((entry) => sameName(entry.name, name));
        if (known) {
            return known.code;
        }

        const base = initials(name);
        let code = base;
        for (let suffix = 1; this.taken.has(code.toLowerCase()); suffix++) {
            code = `${base}${String.fromCharCode(97 + suffix)}`;
        }

        this.add(name, code);
        return code;
    }

    private add(name: string, code: string): void {
        const stays = this.raw.people.find((person) => sameName(person.name, name))?.stays ?? [];
        const last = stays.at(-1);
        const seat = seatOf(this.raw.meeting.seats, name, last?.leaveSource ? last.toSec : undefined);
        const self = this.raw.people.some((person) => person.self && sameName(person.name, name));
        const named = this.labels[name];
        this.entries.push({
            code,
            name,
            ...(seat ? { seat } : {}),
            ...(self ? { self } : {}),
            ...(named && !sameName(named, name) ? { named } : {}),
        });
        this.taken.add(code.toLowerCase());
    }
}

/** A code with a rounded percent after it; a code that ends in a digit gets a colon, so "S1:81" never reads as S181. */
function scored(code: string, score: number | undefined): string {
    if (score === undefined) {
        return code;
    }

    const percent = Math.round(score * 100);
    return /\d$/.test(code) ? `${code}:${percent}` : `${code}${percent}`;
}

/**
 * The table of a meeting's raw facts. Verdicts join by transcript index, never by time or order: two lines can start
 * in the same second. Without verdicts every voice cell is "-".
 */
export function lineTable(options: {
    raw: RawMeeting;
    /** The meeting's people, as `decisionPeople` lists them for `items from-decisions`. */
    people?: readonly string[];
    /** The record's source labels named as people (`speakers.labels`). */
    labels?: Readonly<Record<string, string>>;
    verdicts?: readonly VoiceVerdict[];
}): LineTable {
    const { raw, verdicts } = options;
    const legend = new Legend(raw, options.people ?? [], options.labels ?? {});

    const byIndex = new Map((verdicts ?? []).map((verdict) => [verdict.index, verdict]));
    const rows = raw.lines.map((line): LineTableRow => {
        const verdict = byIndex.get(line.index);
        const voice = !verdict ? "-" : verdict.person ? scored(legend.code(verdict.person), verdict.score) : "?";
        return {
            idx: line.index,
            t: formatClock(line.fromSec),
            label: legend.code(line.label),
            mic: line.channel.micShare === null ? "" : String(Math.round(line.channel.micShare * 100)),
            spk: line.speakingUnknown ? "?" : line.speaking.map((name) => legend.code(name)).join("+"),
            voice,
            next: verdict?.next ? scored(legend.code(verdict.next.person), verdict.next.score) : "",
            text: line.text,
        };
    });
    return { legend: legend.entries, rows, voices: verdicts !== undefined };
}

function entryText(entry: LegendEntry, between: string): string {
    const about = [entry.seat, entry.self ? "self" : undefined, entry.named ? `named ${entry.named}` : undefined]
        .filter(Boolean)
        .join(", ");
    return `${entry.code}${between}${entry.name}${about ? ` (${about})` : ""}`;
}

function legendLine(legend: readonly LegendEntry[]): string {
    return `# legend ${legend.map((entry) => entryText(entry, "=")).join("; ")}`.replace(/[\t\r\n]+/g, " ");
}

function rowLine(row: LineTableRow): string {
    return tsvLine(LINE_TABLE_COLUMNS.map((column) => row[column]));
}

/** The table as TSV: the legend line, the header, then one row per line; `rows` prints a part with the same legend. */
export function lineTableTsv(table: Pick<LineTable, "legend" | "rows">, rows = table.rows): string {
    return [legendLine(table.legend), tsvLine(LINE_TABLE_COLUMNS), ...rows.map(rowLine)].join("\n");
}

/**
 * The rows cut into chunks of about `chunkChars` characters each, every chunk with the legend and the header. A chunk
 * ends at the last change of label that keeps it within the size, when that holds at least half of it; else at the
 * first change of label up to 120 % of the size; else, when one speaker talks on, at the size.
 */
export function chunkLineTable(table: Pick<LineTable, "legend" | "rows">, chunkChars: number): LineTableRow[][] {
    const { rows } = table;
    const fixed = legendLine(table.legend).length + tsvLine(LINE_TABLE_COLUMNS).length + 2;
    const lengths = rows.map((row) => rowLine(row).length + 1);
    const turnAt = (index: number) => index < rows.length && rows[index]?.label !== rows[index - 1]?.label;
    const chunks: LineTableRow[][] = [];
    let start = 0;
    while (start < rows.length) {
        let end = start;
        let size = fixed;
        let lastTurn = -1;
        let lastTurnSize = 0;
        while (end < rows.length && (end === start || size + (lengths[end] ?? 0) <= chunkChars)) {
            size += lengths[end] ?? 0;
            end++;
            if (turnAt(end)) {
                lastTurn = end;
                lastTurnSize = size;
            }
        }

        if (end >= rows.length) {
            chunks.push(rows.slice(start));
            break;
        }

        let cut = lastTurn > start && lastTurnSize >= chunkChars * HALF_CHUNK ? lastTurn : -1;
        for (let next = end, past = size; cut < 0 && next < rows.length; next++) {
            past += lengths[next] ?? 0;
            if (past > chunkChars * PAST_CHUNK) {
                break;
            }

            if (turnAt(next + 1)) {
                cut = next + 1;
            }
        }

        const stop = cut < 0 ? end : cut;
        chunks.push(rows.slice(start, stop));
        start = stop;
    }

    return chunks;
}

async function readTable(
    opened: OpenedMeeting,
    options: { window?: { fromSec: number; toSec: number }; withVoices?: boolean }
): Promise<{ raw: RawMeeting; table: LineTable }> {
    const raw = await channelEvidence(opened, options.window);
    const verdicts = options.withVoices
        ? (await previewVoices({ store: opened.store, meeting: opened.record.id })).lines
        : undefined;
    const record = opened.record;
    return {
        raw,
        table: lineTable({ raw, people: decisionPeople(record), labels: record.speakers.labels, verdicts }),
    };
}

/** `evidence --format tsv`: the line table of the meeting or of the lines that start in `window`. */
export async function readLineTable(
    opened: OpenedMeeting,
    options: { window?: { fromSec: number; toSec: number }; withVoices?: boolean } = {}
): Promise<LineTable> {
    return (await readTable(opened, options)).table;
}

function stayText(stay: RawMeeting["people"][number]["stays"][number]): string {
    const sources = [stay.source ? `join: ${stay.source}` : "", stay.leaveSource ? `leave: ${stay.leaveSource}` : ""]
        .filter(Boolean)
        .join(", ");
    return `${formatClock(stay.fromSec)}–${formatClock(stay.toSec)}${sources ? ` (${sources})` : ""}`;
}

function deviceText(devices: Record<string, unknown>): string {
    return Object.entries(devices)
        .map(([key, value]) => `${key}: ${typeof value === "string" ? value : SafeJSON.stringify(value)}`)
        .join("; ");
}

/** facts.md of a pack: what the table's rows do not repeat on every line. */
export function packFacts(options: {
    raw: RawMeeting;
    table: LineTable;
    chunks: readonly PackChunk[];
    devices?: Record<string, unknown>;
}): string {
    const { raw, table, chunks } = options;
    const meeting = raw.meeting;
    const seats = meeting.seats;
    const remote = (seats?.remote ?? []).map((row) => seatSpan(row).name);
    const room = (seats?.room ?? []).map((row) => seatSpan(row).name);
    const present = raw.people.filter((person) => person.stays.length > 0);
    const absent = raw.people.filter((person) => person.stays.length === 0);
    const perLabel = new Map<string, number>();
    for (const row of table.rows) {
        perLabel.set(row.label, (perLabel.get(row.label) ?? 0) + 1);
    }

    const nameOf = (code: string) => table.legend.find((entry) => entry.code === code)?.name ?? code;
    const lines = [
        `# ${meeting.title} (${meeting.id})`,
        "",
        `- Start: ${meeting.start}${meeting.end ? `, end: ${meeting.end}` : ""}${meeting.platform ? `, platform: ${meeting.platform}` : ""}`,
        `- Lines: ${table.rows.length} in ${chunks.length} chunks: ${chunks.map((chunk) => `${chunk.file} (idx ${chunk.fromIdx}–${chunk.toIdx}, ${chunk.rows} rows)`).join(", ")}`,
        `- Columns: ${LINE_TABLE_COLUMNS.join(" ")}. t is the line's start; mic is the microphone share 0..100 (empty when no audio covers the line); spk is who the speaking indicator showed, "+" joined ("?" unknown); voice is the best voice with its score ("?" named nobody, "-" no voice verdict for the line); next is the runner-up.`,
        `- Voices: ${table.voices ? `read; ${table.rows.filter((row) => row.voice !== "-").length} of ${table.rows.length} lines have a voice verdict` : "not read (--no-voices); every voice cell is -"}`,
        `- Decisions name a person by a legend code or full name, or "?" (items from-decisions).`,
        "",
        "## Legend",
        "",
        ...table.legend.map((entry) => `- ${entryText(entry, " = ")}`),
        "",
        "## Seats",
        "",
        ...(seats
            ? [`- Room: ${room.join(", ") || "nobody"}`, `- Remote: ${remote.join(", ") || "nobody"}`]
            : ["- Not set."]),
        ...(seats?.microphones ?? []).map((mic) => `- Microphone ${mic.label ?? mic.id}: ${mic.people.join(", ")}`),
        "",
        "## People and stays",
        "",
        ...present.map(
            (person) =>
                `- ${person.name}${person.self ? " (self)" : ""}${person.role ? `, ${person.role}` : ""}${person.origin ? `, from ${person.origin}` : ""}: ${person.stays.map(stayText).join("; ")}`
        ),
        `- Absent (the record knows them, with no stay): ${absent.map((person) => person.name).join(", ") || "nobody"}`,
        "",
        "## Audio",
        "",
        `- Channel layout: ${meeting.channelLayout ?? "unknown"}`,
        `- Devices: ${options.devices ? deviceText(options.devices) : "not recorded"}`,
        ...(meeting.callSilent?.length
            ? [
                  `- Call channel silent while the microphone heard speech: ${meeting.callSilent.map((span) => `${formatClock(span.fromSec)}–${formatClock(span.toSec)}`).join(", ")}`,
              ]
            : []),
        ...(meeting.indicatorGaps?.length
            ? [
                  `- Speaking indicator gaps (spk is empty there): ${meeting.indicatorGaps.map((gap) => `${formatClock(gap.fromSec)}–${formatClock(gap.toSec)}`).join(", ")}`,
              ]
            : []),
        ...(meeting.indicator
            ? [
                  `- Speaking indicator: ${meeting.indicator.signal}, ${meeting.indicator.dominant.name} shown ${Math.round(meeting.indicator.dominant.share * 100)} % of the time`,
              ]
            : []),
        "",
        "## Lines per label",
        "",
        ...[...perLabel].map(([code, count]) => `- ${code} (${nameOf(code)}): ${count}`),
        "",
    ];
    return lines.join("\n");
}

/**
 * `pack`: the line table cut into `lines-<n>.tsv` chunks and facts.md, in a new or empty folder. Voices are read
 * unless `withVoices` is false; a voice read that fails stops the pack (`--no-voices` packs without them).
 */
export async function packMeeting(
    opened: OpenedMeeting,
    options: { out: string; chunkChars?: number; withVoices?: boolean }
): Promise<PackResult> {
    const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
    if (!Number.isInteger(chunkChars) || chunkChars < 1000) {
        throw new Error("--chunk-chars needs a whole number of characters, 1000 or more");
    }

    if (existsSync(options.out) && readdirSync(options.out).length > 0) {
        throw new Error(
            `${options.out} is not empty. pack writes into a new or empty folder, so no old chunk is left beside the new ones.`
        );
    }

    const { raw, table } = await readTable(opened, { withVoices: options.withVoices !== false });
    const devices = (await opened.evidence())?.devices;
    mkdirSync(options.out, { recursive: true });
    const chunks: PackChunk[] = [];
    for (const [index, rows] of chunkLineTable(table, chunkChars).entries()) {
        const file = `lines-${index + 1}.tsv`;
        const text = `${lineTableTsv(table, rows)}\n`;
        await Bun.write(join(options.out, file), text);
        chunks.push({
            file,
            fromIdx: rows[0]?.idx ?? 0,
            toIdx: rows.at(-1)?.idx ?? 0,
            rows: rows.length,
            chars: text.length,
        });
    }

    const facts = join(options.out, "facts.md");
    await Bun.write(facts, packFacts({ raw, table, chunks, ...(devices ? { devices } : {}) }));
    return { out: options.out, facts, chunks, rows: table.rows.length, voices: table.voices };
}
