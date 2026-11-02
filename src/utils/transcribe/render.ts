import { firstName } from "./speakers";
import type { TermSuggestion } from "./terms";
import type { TranscriptEntry } from "./types";

export const TRANSCRIPT_FORMATS = ["md", "txt", "json", "srt", "vtt"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** A pause this long inside one speaker's turn starts a new paragraph. */
const PARAGRAPH_GAP_SEC = 30;
/** A paragraph this long breaks at the next sentence end. */
const PARAGRAPH_CHARS = 700;
/** A subtitle cue with no next cue to end at lasts this long at most. */
const LAST_CUE_SEC = 6;

export interface Paragraph {
    startSec?: number;
    text: string;
}

export interface Turn {
    speaker: string;
    startSec?: number;
    paragraphs: Paragraph[];
}

/** Consecutive lines of one speaker become one turn; long turns split into paragraphs at pauses. */
export function groupTurns(entries: TranscriptEntry[], useFirstNames = false): Turn[] {
    const turns: Turn[] = [];
    let previousStart: number | undefined;

    for (const entry of entries) {
        const speaker = useFirstNames ? firstName(entry.speaker) : entry.speaker;
        const text = entry.text.trim();

        if (!text) {
            continue;
        }

        const turn = turns.at(-1);

        if (!turn || turn.speaker !== speaker) {
            turns.push({ speaker, startSec: entry.startSec, paragraphs: [{ startSec: entry.startSec, text }] });
            previousStart = entry.startSec;
            continue;
        }

        const paragraph = turn.paragraphs.at(-1)!;
        const paused =
            entry.startSec !== undefined &&
            previousStart !== undefined &&
            entry.startSec - previousStart >= PARAGRAPH_GAP_SEC;
        const long = paragraph.text.length >= PARAGRAPH_CHARS && /[.!?…]$/.test(paragraph.text);

        if (paused || long) {
            turn.paragraphs.push({ startSec: entry.startSec, text });
        } else {
            paragraph.text = `${paragraph.text} ${text}`;
        }

        previousStart = entry.startSec;
    }

    return turns;
}

export function formatClock(totalSec: number): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");

    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `1:23:50`, `23:50` or `90` (seconds) to seconds; undefined for anything else. The inverse of `formatClock`. */
export function parseClock(value: string): number | undefined {
    const parts = value.trim().split(":");

    if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) {
        return undefined;
    }

    return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** Local wall time, `YYYY-MM-DD HH:MM`. */
export function localTime(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** An Obsidian callout listing each suspect term with its candidates, plus the command that applies them. */
export function suspectsCallout(suspects: TermSuggestion[], options: { tool: string; fixCommand?: string }): string {
    const lines = [`> [!warning]- Possibly misheard terms (${options.tool}, confidence per candidate)`];

    for (const s of suspects) {
        const candidates = s.candidates.map((c) => `${c.term} ${c.confidence} % (${c.source})`).join(" · ");
        const note = s.kind === "stem" ? " _(inflected; name it explicitly to fix)_" : "";
        lines.push(`> - \`${s.heard}\` ×${s.occurrences}: ${candidates}${note}`);
    }

    if (options.fixCommand) {
        lines.push(">", `> Apply: \`${options.fixCommand}\``);
    }

    return lines.join("\n");
}

/** The turns as Markdown: a bold speaker per turn, one block per paragraph. */
export function transcriptMarkdown(turns: Turn[], timestamps: boolean): string {
    const blocks: string[] = [];

    for (const turn of turns) {
        turn.paragraphs.forEach((paragraph, index) => {
            const stamp =
                timestamps && paragraph.startSec !== undefined ? ` \`${formatClock(paragraph.startSec)}\`` : "";

            if (index === 0) {
                blocks.push(`**${turn.speaker}:**${stamp} ${paragraph.text}`);
            } else {
                blocks.push(`${stamp.trim()}${stamp ? " " : ""}${paragraph.text}`);
            }
        });
    }

    return blocks.join("\n\n");
}

/** The turns as plain text lines: `Speaker [time]:`, then each paragraph followed by an empty line. */
export function transcriptTextLines(turns: Turn[], timestamps: boolean): string[] {
    const lines: string[] = [];

    for (const turn of turns) {
        const stamp = timestamps && turn.startSec !== undefined ? ` [${formatClock(turn.startSec)}]` : "";
        lines.push(`${turn.speaker}${stamp}:`);

        for (const paragraph of turn.paragraphs) {
            lines.push(paragraph.text, "");
        }
    }

    return lines;
}

interface Cue {
    start: number;
    end: number;
    speaker: string;
    text: string;
}

/** One cue per transcript line; each ends where the next begins. Lines without a time are dropped. */
export function subtitleCues(entries: TranscriptEntry[], useFirstNames = false): Cue[] {
    const timed = entries.filter((e) => e.startSec !== undefined && e.text.trim());

    return timed.map((entry, i) => {
        const start = entry.startSec!;
        const next = timed[i + 1]?.startSec;
        const end = next !== undefined && next > start ? next : start + LAST_CUE_SEC;

        return {
            start,
            end,
            speaker: useFirstNames ? firstName(entry.speaker) : entry.speaker,
            text: entry.text.trim(),
        };
    });
}

function cueTime(totalSec: number, separator: "," | "."): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const ms = Math.round((totalSec % 1) * 1000);

    return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

export function entriesToSrt(entries: TranscriptEntry[], useFirstNames = false): string {
    return subtitleCues(entries, useFirstNames)
        .map(
            (cue, i) =>
                `${i + 1}\n${cueTime(cue.start, ",")} --> ${cueTime(cue.end, ",")}\n${cue.speaker}: ${cue.text}\n`
        )
        .join("\n");
}

export function entriesToVtt(entries: TranscriptEntry[], useFirstNames = false): string {
    const cues = subtitleCues(entries, useFirstNames).map(
        (cue) => `${cueTime(cue.start, ".")} --> ${cueTime(cue.end, ".")}\n<v ${cue.speaker}>${cue.text}\n`
    );

    return `WEBVTT\n\n${cues.join("\n")}`;
}

/** Subtitles need a time per line. */
export function formatNeedsTimes(format: TranscriptFormat): boolean {
    return format === "srt" || format === "vtt";
}
