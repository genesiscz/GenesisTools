import { logger } from "@genesiscz/utils/logger";
import { FRAME_RECORDER_IDS } from "@genesiscz/utils/screen-recorder/types";
import { Storage } from "@genesiscz/utils/storage/storage";
import {
    type AbbrExpansion,
    type DictionaryEntry,
    type DictionaryLevel,
    dictionaryLevelSchema,
    mergeDictionaries,
    type ResolvedDictionary,
} from "@genesiscz/utils/transcribe/dictionary";
import { z } from "zod";

const { log } = logger.scoped("meetings-config");

/** A project name: a folder-safe word, so it can name a folder and a CLI argument. */
export const projectNameSchema = z
    .string()
    .regex(
        /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u,
        "a project name is letters, digits, '_', '.' and '-', starting with a letter or digit"
    );

const strings = z.array(z.string().trim().min(1)).default([]);

/**
 * How a meeting finds its project when no `--project` is given. One block per origin of the fact, because each
 * names things its own way: Wispr Flow by folder, the calendar by calendar name and event title.
 */
const projectMatchSchema = z.object({
    wisprflow: z.object({ folders: strings }).optional(),
    calendar: z.object({ calendars: strings, titles: strings }).optional(),
});

const projectSchema = z.object({
    dictionary: dictionaryLevelSchema.optional(),
    match: projectMatchSchema.optional(),
});

export const DISPLAY_POLICIES = ["all", "follow-focus", "main"] as const;
/** Which displays the recorder records: every connected one, the one with the focused window, the main one, or an index. */
export const displayPolicySchema = z.union([z.enum(DISPLAY_POLICIES), z.number().int().nonnegative()]);
export type DisplayPolicy = z.infer<typeof displayPolicySchema>;

const captureSchema = z.object({
    /** The frame recorder: GenesisTools' own ScreenCaptureKit recorder (`native`) or `peekaboo`. */
    backend: z.enum(FRAME_RECORDER_IDS).default("native"),
    displays: displayPolicySchema.default("all"),
    /** Frames per second while the screen changes. */
    activeFps: z.number().positive().default(1),
    /** Frames per second while it does not. */
    idleFps: z.number().positive().default(0.1),
    /** The share of the screen that must change for a new frame (0 to 1). */
    threshold: z.number().min(0).max(1).default(0.02),
    jpegQuality: z.number().min(0.1).max(1).default(0.75),
    /** The longest side of a frame in pixels. Smaller text than this keeps is lost to OCR on a large display. */
    resolutionCap: z.number().int().min(640).max(8192).default(2880),
    /** Frames and OCR older than this are deleted; the meeting record stays. */
    retentionDays: z.number().int().positive().default(30),
});

/** Wispr Flow's own keys. Only Wispr code reads them. */
const wisprflowSourceSchema = z.object({
    /** Start a screen recording when Wispr Flow starts recording a meeting. Off by default. */
    autoRecord: z
        .object({
            enabled: z.boolean().default(false),
            /** A recording is live while its live transcript changed this recently. */
            liveWithinSec: z.number().int().positive().default(30),
            /** Stop when the live transcript has been silent this long. */
            stopAfterSilenceSec: z.number().int().positive().default(120),
            /** Post a notification when a recording starts by itself. */
            notify: z.boolean().default(true),
        })
        .prefault({}),
    suggest: z.object({ ignore: strings }).prefault({}),
});

/** The players `tools meetings play` can start, in the order it tries them. */
export const MEETING_PLAYERS = ["vlc", "ffplay"] as const;

/** The players `tools meetings listen` can play a cut clip with, in the order it tries them. */
export const LISTEN_PLAYERS = ["afplay", "vlc", "ffplay"] as const;

const listenSchema = z.object({
    /** Plays the cut clip; a clip needs no seeking, so macOS's own afplay is enough. */
    player: z.enum(LISTEN_PLAYERS).default("afplay"),
    /** Seconds of audio around the question's range. No default: the first `listen` asks and saves it. */
    padSec: z.number().min(0).max(60).optional(),
    /** Questions one `listen` round asks at most; the rest stay as suggestions, marked in the transcript. */
    budget: z.number().int().min(1).max(500).default(12),
    /** A question under this priority is not worth a person's time; it stays a marked suggestion. */
    minPriority: z.number().min(0).default(0.5),
    /** Seconds between showing a question and playing its clip, so the question is read before the audio starts. */
    delaySec: z.number().min(0).max(10).default(2),
    /** A short tone in the clip just before the asked spot: the heard words of a term, the start of a speaker range. */
    beep: z.boolean().default(true),
    /** How long before the asked spot the tone sounds. */
    beepLeadSec: z.number().min(0).max(3).default(0.4),
    /** Plays the clip again each time it ends, until the question is answered, so it can be heard while typing. */
    repeat: z.boolean().default(true),
    /** The pause between two plays of a repeated clip. */
    repeatGapSec: z.number().min(0).max(10).default(1),
});

const playbackSchema = z.object({
    /** Which player opens a meeting's audio at a moment; the other is the fallback when it is missing. */
    player: z.enum(MEETING_PLAYERS).default("vlc"),
    /** Start this many seconds before the asked time, so the sentence is heard from its start. */
    beforeSec: z.number().min(0).max(60).default(5),
    listen: listenSchema.prefault({}),
});

/** The summary headings whose bullets are action items or decisions, in the languages summaries are written in. */
const summarySchema = z.object({
    actionHeadings: z.array(z.string().trim().min(1)).default(["Další kroky", "Úkoly", "Next steps", "Action items"]),
    decisionHeadings: z.array(z.string().trim().min(1)).default(["Přijatá rozhodnutí", "Rozhodnutí", "Decisions"]),
});

const renderSchema = z.object({
    /** The word an open passage starts with in a transcript: `[nejasné: "<raw>"; 1) … 2) …]`. */
    unclearLabel: z.string().trim().min(1).default("nejasné"),
    /** How a quote names its source: `(<readAloudLabel> WikiProposals, <lineLabel> 33)`. */
    readAloudLabel: z.string().trim().min(1).default("čte z"),
    lineLabel: z.string().trim().min(1).default("ř."),
});

export const meetingsConfigSchema = z.object({
    version: z.literal(1).default(1),
    global: z
        .object({
            dictionary: dictionaryLevelSchema.prefault({}),
            capture: captureSchema.prefault({}),
            playback: playbackSchema.prefault({}),
            render: renderSchema.prefault({}),
            summary: summarySchema.prefault({}),
            suggest: z
                .object({
                    /** An item under this confidence that matters (enough words, or a decision) becomes a question. */
                    listenBelow: z.number().min(0).max(1).default(0.6),
                    /** `--with-suggested` applies a suggested item at this confidence or more; a lower one is marked unclear. */
                    applyAbove: z.number().min(0).max(1).default(0.5),
                })
                .prefault({}),
        })
        .prefault({}),
    /** The known projects. `--project` with a new name adds one here. */
    projects: z.record(projectNameSchema, projectSchema).default({}),
    /** One block per transcript source, holding only the keys that source reads. */
    sources: z.object({ wisprflow: wisprflowSourceSchema.prefault({}) }).prefault({}),
});

export type MeetingsConfig = z.infer<typeof meetingsConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;

/** Facts about a meeting that a project's match rules can test. */
export interface ProjectMatchFacts {
    wisprflowFolders?: string[];
    calendar?: string;
    title?: string;
}

/** The known projects whose match rules fit these facts, in config order. */
export function matchProjects(config: MeetingsConfig, facts: ProjectMatchFacts): string[] {
    const folders = new Set((facts.wisprflowFolders ?? []).map((name) => name.toLowerCase()));
    const title = facts.title?.toLowerCase() ?? "";
    const calendar = facts.calendar?.toLowerCase();

    return Object.entries(config.projects)
        .filter(([, project]) => {
            const match = project.match;

            if (!match) {
                return false;
            }

            const byFolder = (match.wisprflow?.folders ?? []).some((name) => folders.has(name.toLowerCase()));
            const byCalendar =
                calendar !== undefined &&
                (match.calendar?.calendars ?? []).some((name) => name.toLowerCase() === calendar);
            const byTitle =
                title !== "" && (match.calendar?.titles ?? []).some((word) => title.includes(word.toLowerCase()));

            return byFolder || byCalendar || byTitle;
        })
        .map(([name]) => name);
}

/** The dictionary for a meeting: global, then its project, then the meeting's own level. */
export function resolveDictionary(
    config: MeetingsConfig,
    options: { project?: string; meeting?: DictionaryLevel } = {}
): ResolvedDictionary {
    const project = options.project ? config.projects[options.project]?.dictionary : undefined;
    return mergeDictionaries([config.global.dictionary, project, options.meeting]);
}

/** Where a dictionary level lives in the config. */
export type DictionaryScope = { kind: "global" } | { kind: "project"; project: string };

function formatIssues(error: z.ZodError, path: string): string {
    const issues = error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return `Invalid meetings config at ${path}:\n${issues.join("\n")}`;
}

/** `~/.genesis-tools/meetings/config.json`: read with every default filled in, changed only through `update()`. */
export class MeetingsConfigStore {
    readonly storage: Storage;

    constructor(storage = new Storage("meetings")) {
        this.storage = storage;
    }

    get path(): string {
        return this.storage.getConfigPath();
    }

    /** The config with every default filled in. A missing file is the defaults; an invalid one throws with each issue. */
    async read(): Promise<MeetingsConfig> {
        const raw = (await this.storage.getConfig<Record<string, unknown>>()) ?? {};
        const parsed = meetingsConfigSchema.safeParse(raw);

        if (!parsed.success) {
            throw new Error(formatIssues(parsed.error, this.path));
        }

        return parsed.data;
    }

    /**
     * Changes the file under its lock. `mutate` edits the raw JSON (so keys a person wrote stay as written), and the
     * result must still validate, or nothing is written.
     */
    async update(mutate: (raw: Record<string, unknown>) => void): Promise<MeetingsConfig> {
        let validated: MeetingsConfig | undefined;

        await this.storage.atomicConfigUpdate<Record<string, unknown>>((raw) => {
            raw.version ??= 1;
            mutate(raw);
            const parsed = meetingsConfigSchema.safeParse(raw);

            if (!parsed.success) {
                throw new Error(formatIssues(parsed.error, this.path));
            }

            validated = parsed.data;
        });

        log.debug({ path: this.path }, "meetings config updated");
        return validated!;
    }

    /** Adds a project to the known ones. Returns false when it was known already. */
    async addProject(name: string): Promise<boolean> {
        projectNameSchema.parse(name);
        let added = false;

        await this.update((raw) => {
            const projects = objectAt(raw, "projects");

            if (!projects[name]) {
                projects[name] = {};
                added = true;
            }
        });

        return added;
    }

    /** Adds or replaces the entry for `entry.value` in one dictionary level. */
    async putDictionaryEntry(scope: DictionaryScope, entry: DictionaryEntry): Promise<MeetingsConfig> {
        return this.putDictionaryEntries(scope, [entry]);
    }

    /** Adds or replaces several entries in one level, in one write. */
    async putDictionaryEntries(scope: DictionaryScope, added: DictionaryEntry[]): Promise<MeetingsConfig> {
        const values = new Set(added.map((entry) => entry.value));

        return this.update((raw) => {
            const level = dictionaryAt(raw, scope);
            const entries = Array.isArray(level.entries) ? (level.entries as Array<{ value?: unknown }>) : [];
            level.entries = [
                ...entries.filter((existing) => typeof existing.value !== "string" || !values.has(existing.value)),
                ...added,
            ];
        });
    }

    /** Sets how abbreviations expand on one level. */
    async setAbbrExpansion(scope: DictionaryScope, mode: AbbrExpansion): Promise<MeetingsConfig> {
        return this.update((raw) => {
            dictionaryAt(raw, scope).abbrExpansion = mode;
        });
    }

    /** Saves the padding `tools meetings listen` cuts around a question's range. */
    async setListenPad(padSec: number): Promise<MeetingsConfig> {
        return this.update((raw) => {
            objectAt(objectAt(objectAt(raw, "global"), "playback"), "listen").padSec = padSec;
        });
    }

    /** Turns Wispr Flow's autostart on or off, keeping its other settings. */
    async setAutoRecord(enabled: boolean): Promise<MeetingsConfig> {
        return this.update((raw) => {
            objectAt(objectAt(objectAt(raw, "sources"), "wisprflow"), "autoRecord").enabled = enabled;
        });
    }

    /** Removes the entry for `value` from one level. Returns false when it was not there. */
    async removeDictionaryEntry(scope: DictionaryScope, value: string): Promise<boolean> {
        let removed = false;

        await this.update((raw) => {
            const level = dictionaryAt(raw, scope);
            const entries = Array.isArray(level.entries) ? (level.entries as Array<{ value?: unknown }>) : [];
            const kept = entries.filter((existing) => existing.value !== value);
            removed = kept.length !== entries.length;
            level.entries = kept;
        });

        return removed;
    }
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = parent[key];

    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
}

function dictionaryAt(raw: Record<string, unknown>, scope: DictionaryScope): Record<string, unknown> {
    if (scope.kind === "global") {
        return objectAt(objectAt(raw, "global"), "dictionary");
    }

    projectNameSchema.parse(scope.project);
    return objectAt(objectAt(objectAt(raw, "projects"), scope.project), "dictionary");
}
