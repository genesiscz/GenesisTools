import type { TimestampedSummaryEntry } from "@app/youtube/lib/types";

/**
 * Best-effort partial of `VideoLongSummary` as streamed by `streamObject`.
 * Every field may be missing and the last array item may be truncated.
 */
export interface PartialLongSummary {
    tldr?: string;
    keyPoints?: Array<string | undefined>;
    learnings?: Array<string | undefined>;
    chapters?: Array<{ title?: string; summary?: string } | undefined>;
    conclusion?: string | null;
}

export function toPartialLongSummary(partial: unknown): PartialLongSummary | null {
    if (partial === null || typeof partial !== "object") {
        return null;
    }

    const source = partial as Record<string, unknown>;
    const result: PartialLongSummary = {};

    if (typeof source.tldr === "string") {
        result.tldr = source.tldr;
    }

    if (Array.isArray(source.keyPoints)) {
        result.keyPoints = source.keyPoints.map((point) => (typeof point === "string" ? point : undefined));
    }

    if (Array.isArray(source.learnings)) {
        result.learnings = source.learnings.map((point) => (typeof point === "string" ? point : undefined));
    }

    if (Array.isArray(source.chapters)) {
        result.chapters = source.chapters.map((chapter) => {
            if (chapter === null || typeof chapter !== "object") {
                return undefined;
            }

            const raw = chapter as Record<string, unknown>;
            return {
                title: typeof raw.title === "string" ? raw.title : undefined,
                summary: typeof raw.summary === "string" ? raw.summary : undefined,
            };
        });
    }

    if (typeof source.conclusion === "string" || source.conclusion === null) {
        result.conclusion = source.conclusion;
    }

    return result;
}

/**
 * Extracts renderable, complete-enough entries from a streamed partial of the
 * timestamped structured response (`{ tldr, sections }`). Sections without a
 * numeric `startSec` or non-empty `text` yet are dropped, so the view renders
 * only stable cards while the stream grows.
 */
export function toPartialTimestampedEntries(partial: unknown): { entries: TimestampedSummaryEntry[]; tldr: string | null } {
    if (partial === null || typeof partial !== "object") {
        return { entries: [], tldr: null };
    }

    const source = partial as { tldr?: unknown; sections?: unknown };
    const tldr = typeof source.tldr === "string" ? source.tldr : null;

    if (!Array.isArray(source.sections)) {
        return { entries: [], tldr };
    }

    const entries: TimestampedSummaryEntry[] = [];

    for (const section of source.sections) {
        if (section === null || typeof section !== "object") {
            continue;
        }

        const raw = section as Record<string, unknown>;

        if (typeof raw.startSec !== "number" || typeof raw.text !== "string" || raw.text.length === 0) {
            continue;
        }

        entries.push({
            startSec: raw.startSec,
            endSec: typeof raw.endSec === "number" ? raw.endSec : raw.startSec,
            icon: typeof raw.icon === "string" ? raw.icon : undefined,
            title: typeof raw.title === "string" ? raw.title : undefined,
            question: typeof raw.question === "string" ? raw.question : undefined,
            text: raw.text,
        });
    }

    return { entries, tldr };
}
