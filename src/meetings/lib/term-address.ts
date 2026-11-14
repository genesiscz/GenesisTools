import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { heardLineAt } from "@genesiscz/utils/transcribe/apply";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { termFixPattern } from "@genesiscz/utils/transcribe/terms";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

export interface TermAddressDiagnostic {
    item: string;
    kind: "found" | "ambiguous" | "no-line" | "wrong-line" | "not-heard";
    message?: string;
    line?: number;
    nearest?: { line: number; atSec: number; text: string };
}

/** Uses the same whole-word and line-resolution rules as applying a term. Line numbers are zero-based. */
export function diagnoseTermAddress(options: {
    item: Extract<MeetingItem, { kind: "term" }>;
    transcript: readonly TranscriptEntry[];
}): TermAddressDiagnostic | undefined {
    const { item, transcript } = options;

    if (item.atSec === undefined || (item.scope !== "line" && !item.meaning && !item.quote)) {
        return undefined;
    }

    const lines = new TranscriptLines(transcript);
    // A marked term (meaning or quote) applies as a mark on the literal heard word, never through its stem.
    const marked = Boolean(item.meaning || item.quote);
    const stemPattern = termFixPattern({
        heard: item.heard,
        replacement: item.proposed ?? item.heard,
        ...(marked ? {} : { heardStem: item.heardStem, proposedStem: item.proposedStem }),
    });
    const pattern = new RegExp(stemPattern.source, stemPattern.flags.replace("g", ""));
    const explicit = item.evidence?.transcriptLine;
    const found = heardLineAt(
        lines,
        {
            atSec: item.atSec,
            ...(typeof explicit === "number" ? { line: explicit } : {}),
        },
        pattern
    );

    if (found.kind === "found" && pattern.test(transcript[found.index]!.text)) {
        return { item: item.id, kind: "found", line: found.index };
    }

    if (found.kind === "ambiguous") {
        return {
            item: item.id,
            kind: "ambiguous",
            message: `${found.indexes.length} lines with "${item.heard}" start at ${formatClock(item.atSec)}; choose a line: ${found.indexes.join(", ")}`,
        };
    }

    const nearest = transcript
        .flatMap((entry, line) =>
            entry.startSec !== undefined && pattern.test(entry.text)
                ? [{ line, atSec: entry.startSec, text: entry.text }]
                : []
        )
        .sort((a, b) => Math.abs(a.atSec - item.atSec!) - Math.abs(b.atSec - item.atSec!) || a.line - b.line)[0];
    const at = formatClock(item.atSec);
    const suffix = nearest
        ? `; heard at ${formatClock(nearest.atSec)} (line ${nearest.line})`
        : `; "${item.heard}" is not heard in any line`;
    const noLine = lines.at(item.atSec).kind === "none";
    return {
        item: item.id,
        kind: noLine ? "no-line" : nearest ? "wrong-line" : "not-heard",
        message: `${noLine ? `no line starts at ${at}` : `no "${item.heard}" at ${at}`}${suffix}`,
        ...(nearest ? { nearest } : {}),
    };
}
