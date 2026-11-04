import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { groupTurns } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { playLinksFor } from "./link";
import { OpenedMeeting } from "./opened-meeting";
import { type CorrectedTranscript, correctTranscript } from "./transcript-corrections";
import { transcriptDocument } from "./transcript-document";

export interface TranscriptMarkdownOptions {
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    config: MeetingsConfig;
    withSuggested?: boolean;
    dictionary?: boolean;
    frontmatter: boolean;
    timestamps: boolean;
    playLinks: boolean;
}

/**
 * The meeting's transcript as markdown (json2md frontmatter and body, `transcriptDocument`), with the renames, the
 * confirmed items and the dictionary applied. `warning` says why play links were left out, when they were.
 */
export function transcriptMarkdown(options: TranscriptMarkdownOptions): {
    markdown: string;
    applied: CorrectedTranscript;
    warning?: string;
} {
    const { record } = options;
    const applied = correctTranscript({
        record,
        transcript: options.transcript,
        config: options.config,
        format: "md",
        ...(options.withSuggested !== undefined ? { withSuggested: options.withSuggested } : {}),
        ...(options.dictionary !== undefined ? { dictionary: options.dictionary } : {}),
    });
    // The links are written even while the router preset is off; the warning says how to make them open.
    const links = options.playLinks ? playLinksFor(record.id) : undefined;
    const markdown = transcriptDocument({
        record,
        turns: groupTurns(applied.entries),
        speakers: applied.speakers,
        unattributed: applied.unattributed,
        frontmatter: options.frontmatter,
        timestamps: options.timestamps || options.playLinks,
        ...(links ? { playLink: links.link } : {}),
    });

    return { markdown, applied, ...(links?.warning ? { warning: links.warning } : {}) };
}

export interface ExportResult {
    meeting: string;
    project?: string;
    folder: string;
    path: string;
    bytes: number;
    /** A file of the same meeting was there and is replaced. */
    replaced: boolean;
    written: boolean;
    warning?: string;
}

/** The folder a meeting's export goes to: `to` when given, else its project's `export.folder`. */
export function exportFolder(config: MeetingsConfig, record: MeetingRecord, to?: string): string | undefined {
    if (to) {
        return isAbsolute(to) ? to : resolve(to);
    }

    return record.project ? config.projects[record.project]?.export?.folder : undefined;
}

/**
 * Writes the polished transcript (play links, dictionary, confirmed items) as `<folder>/<meeting id>.md`. The same
 * meeting exported again replaces its file. `dryRun` answers where it would go and how big it is, and writes nothing.
 */
export async function exportMeeting(options: {
    store: MeetingStore;
    record: MeetingRecord;
    config: MeetingsConfig;
    to?: string;
    dryRun?: boolean;
    transcript?: TranscriptEntry[];
}): Promise<ExportResult> {
    const { record, config } = options;
    const folder = exportFolder(config, record, options.to);

    if (!folder) {
        throw new Error(
            record.project
                ? `project ${record.project} has no export folder: give --to <folder>, or set projects.${record.project}.export.folder`
                : `${record.id} has no project: give --to <folder>, or set its project first`
        );
    }

    const transcript = options.transcript ?? (await OpenedMeeting.of(options.store, record).meeting()).transcript;
    const { markdown, warning } = transcriptMarkdown({
        record,
        transcript,
        config,
        frontmatter: true,
        timestamps: true,
        playLinks: true,
    });
    const path = join(folder, `${record.id}.md`);
    const replaced = existsSync(path);

    if (!options.dryRun) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(path, markdown);
    }

    return {
        meeting: record.id,
        ...(record.project ? { project: record.project } : {}),
        folder,
        path,
        bytes: Buffer.byteLength(markdown),
        replaced,
        written: !options.dryRun,
        ...(warning ? { warning } : {}),
    };
}
