import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingsConfig, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { TranscriptFormat } from "@genesiscz/utils/transcribe/render";
import { type SpeakerStats, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { type AssignDeps, type AssignView, skipReason, viewProposals } from "./assign";
import { configValueAt, parseConfigPath } from "./config-edit";
import { transcriptMarkdown } from "./export";
import { type MatchDraft, type MatchPreviewRow, matchDraftSchema, matchPreview } from "./match-preview";
import { OpenedMeeting } from "./opened-meeting";
import { type MeetingsOverview, meetingsOverview } from "./overview";
import { type CorrectedTranscript, correctTranscript } from "./transcript-corrections";

/**
 * The reads the Meetings window makes, each as the value its command prints with `--json`. The CLI commands and the
 * hub server doors both serialize these with `windowJson`, so a door's answer is byte-identical to the command's.
 */
export function windowJson(value: unknown): string {
    return SafeJSON.stringify(value, null, 2);
}

/** `meetings overview --days <n>`: the meetings of the last `days`, with what needs the user. */
export async function overviewRead(options: { days: number; now: Date }): Promise<MeetingsOverview> {
    const { days, now } = options;
    const bounded = new MeetingStore().listBounded({ since: new Date(now.getTime() - days * 86_400_000) });
    const view = meetingsOverview({
        records: bounded.records,
        config: await new MeetingsConfigStore().read(),
        now,
        days,
    });
    view.olderMeetings += bounded.olderMeetings;
    return view;
}

/** `meetings config show [path]`: the config file's path and the value at `path` (the whole config without one). */
export async function configShowRead(path?: string): Promise<{ path: string; value: unknown }> {
    const store = new MeetingsConfigStore();
    const config = await store.read();
    const value = path ? configValueAt(config, parseConfigPath(path)) : config;
    return { path: store.path, value: value ?? null };
}

export interface DictionaryShowView {
    project: string | null;
    abbrExpansion: ReturnType<typeof resolveDictionary>["abbrExpansion"];
    entries: Array<ReturnType<typeof resolveDictionary>["entries"][number] & { level: string }>;
}

/**
 * `meetings projects preview [--draft <json>] [--limit n]`: the newest meetings against the saved project rules and
 * the draft. `draft` is the parsed draft (undefined without one), which the table view needs.
 */
export async function matchPreviewRead(flags: {
    draft?: string;
    limit?: string;
}): Promise<{ draft: MatchDraft | undefined; rows: MatchPreviewRow[] }> {
    const draft = flags.draft ? matchDraftSchema.parse(SafeJSON.parse(flags.draft, { strict: true })) : undefined;
    const limit = Number(flags.limit ?? "20");
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
    }

    const rows = matchPreview({
        records: new MeetingStore().listBounded({ limit }).records,
        config: await new MeetingsConfigStore().read(),
        ...(draft ? { draft } : {}),
        limit,
    });
    return { draft, rows };
}

/** `meetings dictionary show [--project p]`: the merged dictionary, each entry with the level it comes from. */
export function dictionaryShowRead(config: MeetingsConfig, project?: string): DictionaryShowView {
    if (project && !config.projects[project]) {
        const known = Object.keys(config.projects).join(", ") || "none yet";
        throw new Error(
            `Unknown project ${project}. Known: ${known}. Add it: ${toolCommand("meetings", "projects", "add", project)}`
        );
    }

    const merged = resolveDictionary(config, { project });
    const projectValues = new Set(
        (project ? config.projects[project]?.dictionary?.entries : [])?.map((entry) => entry.value)
    );
    const rows = merged.entries.map((entry) => ({
        ...entry,
        level: projectValues.has(entry.value) ? `project ${project}` : "global",
    }));
    return { project: project ?? null, abbrExpansion: merged.abbrExpansion, entries: rows };
}

export type SpeakerStatsView = { meeting: string; gapSec: number } & SpeakerStats;

/** `meetings speakers stats <id>`: per label its turns, spoken time and spans, on the stays the record keeps. */
export async function speakerStatsRead(options: {
    store: MeetingStore;
    record: MeetingRecord;
    gapSec: number;
    attendance?: string;
}): Promise<SpeakerStatsView> {
    const { store, record, gapSec } = options;
    const opened = OpenedMeeting.of(store, record);
    const meeting = await opened.meeting();
    const stats = speakerStats(meeting.transcript, {
        gapSec,
        participants: meeting.speakers,
        presence: await opened.presence(options.attendance),
    });
    return { meeting: record.id, gapSec, ...stats };
}

/** The transcript flags that change what `meetings transcript` applies or prints. */
export interface TranscriptReadOptions {
    withSuggested?: boolean;
    dictionary?: boolean;
    frontmatter?: boolean;
    timestamps?: boolean;
    playLinks?: boolean;
}

/**
 * `meetings transcript <id> --format <f>`: the source's transcript with the record's corrections applied, and for
 * `md` the whole document. `applied` carries what each correction did, which the command reports on stderr.
 */
export async function correctedTranscriptRead(options: {
    store: MeetingStore;
    record: MeetingRecord;
    format: TranscriptFormat;
    flags: TranscriptReadOptions;
}): Promise<{ markdown?: ReturnType<typeof transcriptMarkdown>; applied: CorrectedTranscript }> {
    const { store, record, format, flags } = options;
    const meeting = await OpenedMeeting.of(store, record).meeting();
    const config = await new MeetingsConfigStore().read();
    const markdown =
        format === "md"
            ? transcriptMarkdown({
                  record,
                  transcript: meeting.transcript,
                  config,
                  ...(flags.withSuggested !== undefined ? { withSuggested: flags.withSuggested } : {}),
                  ...(flags.dictionary !== undefined ? { dictionary: flags.dictionary } : {}),
                  frontmatter: flags.frontmatter !== false,
                  timestamps: flags.timestamps === true,
                  playLinks: flags.playLinks === true,
              })
            : undefined;
    const applied =
        markdown?.applied ?? correctTranscript({ ...flags, record, transcript: meeting.transcript, config, format });
    return { ...(markdown ? { markdown } : {}), applied };
}

/** `meetings transcript <id> --format json`: the corrected lines. */
export function transcriptJsonView(
    record: MeetingRecord,
    applied: CorrectedTranscript
): { meeting: string; entries: CorrectedTranscript["entries"] } {
    return { meeting: record.id, entries: applied.entries };
}

/** `meetings assign proposals <id>`: the ranked projects with their facts, and why the sweep would not ask. */
export async function proposalsRead(options: {
    store: MeetingStore;
    record: MeetingRecord;
    deps: AssignDeps;
}): Promise<{ view: AssignView; skipped: string | undefined }> {
    const { store, record, deps } = options;
    const view = await viewProposals(store, record, deps);
    const { assign } = (await deps.config.read()).global;
    const skipped = skipReason({ record, store, now: deps.now(), retryFailedMin: assign.retryFailedMin });
    return { view, skipped };
}

/** The JSON of `meetings assign proposals <id> --json`: the view without its record. */
export function proposalsJsonView(record: MeetingRecord, read: { view: AssignView; skipped: string | undefined }) {
    return { meeting: record.id, skipped: read.skipped, ...read.view, record: undefined };
}
