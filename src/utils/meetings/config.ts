import { logger } from "@genesiscz/utils/logger";
import { AUDIO_SOURCES } from "@genesiscz/utils/screen-recorder/control";
import { FRAME_RECORDER_IDS, type FrameRecorderId } from "@genesiscz/utils/screen-recorder/types";
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
import { MEETING_SOURCE_IDS, type MeetingSourceId } from "./sources";

const { log } = logger.scoped("meetings-config");

/** A project name: a folder-safe word, so it can name a folder and a CLI argument. */
export const projectNameSchema = z
    .string()
    .regex(
        /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u,
        "a project name is letters, digits, '_', '.' and '-', starting with a letter or digit"
    );

const strings = z.array(z.string().trim().min(1)).default([]);

/** The config shape this code writes. Version 1 files are migrated on the first read (`migrateMeetingsConfig`). */
export const MEETINGS_CONFIG_VERSION = 2;

/** How a meeting finds its project from the calendar. A source's own facts (Wispr folders) sit in `sources.<id>.match`. */
const projectMatchSchema = z.object({
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

/** Keys only GenesisTools' own ScreenCaptureKit recorder reads. Unset keeps ax-tool's own value. */
const nativeRecorderSchema = z.object({
    /** How long the screen must stay still before a change counts as settled, in milliseconds. */
    quietMs: z.number().int().min(0).max(10_000).optional(),
    /** A frame at least this often while nothing changes. */
    heartbeatSec: z.number().positive().optional(),
    /** The most megabytes of frames one capture writes. */
    maxMb: z.number().positive().optional(),
    /** Sound beside the frames, as `.m4a` files in the meeting's `audio/`: off by default (the source records it). */
    audio: z
        .object({
            sources: z.array(z.enum(AUDIO_SOURCES)).default([]),
            /** The microphone's device UID (`ax-tool audio-devices`); unset is the system default input. */
            micDevice: z.string().optional(),
        })
        .prefault({}),
});

/** Peekaboo reads only the shared capture policy. */
const peekabooRecorderSchema = z.object({});

/** One block per frame recorder, holding only the keys that recorder reads. */
const recordersSchema = z.object({
    native: nativeRecorderSchema.prefault({}),
    peekaboo: peekabooRecorderSchema.prefault({}),
}) satisfies z.ZodType<Record<FrameRecorderId, object>>;

/** The capture policy every recorder follows, the recorder that runs, and each recorder's own keys. */
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
    /** The watcher expires frames, OCR and recorded audio this many days after the newest capture-file timestamp; the meeting record stays. */
    retentionDays: z.number().int().positive().default(30),
    recorders: recordersSchema.prefault({}),
});

/** The keys every transcript source has: how its own facts match a project, and what `dictionary suggest` skips. */
const sourceBaseShape = {
    /** Per project, the source's folders that put a meeting in it (`sources.wisprflow.match.work.folders`). */
    match: z.record(projectNameSchema, z.object({ folders: strings })).default({}),
    suggest: z.object({ ignore: strings }).prefault({}),
    /** Start a screen recording when the source starts recording a meeting. Off by default. */
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
};

/** Wispr Flow's block. Only Wispr has a live recording to follow so far, so it holds no keys beyond the shared ones. */
const wisprflowSourceSchema = z.object(sourceBaseShape);

/** One block per transcript source. A new source is one entry here (MEETING_SOURCE_IDS) and one implementation. */
const sourcesSchema = z.object({
    wisprflow: wisprflowSourceSchema.prefault({}),
}) satisfies z.ZodType<Record<MeetingSourceId, object>>;

export type SourceSettings = z.infer<typeof wisprflowSourceSchema>;

/** The players `tools meetings play` can start at a time, in the order it tries them. */
export const MEETING_PLAYERS = ["vlc", "ffplay"] as const;

/** The players `tools meetings listen` can play a cut clip with, in the order it tries them. */
export const LISTEN_PLAYERS = ["afplay", "vlc", "ffplay"] as const;

const listenSchema = z.object({
    /** Plays the cut clip; a clip needs no seeking, so macOS's own afplay is enough. */
    player: z.enum(LISTEN_PLAYERS).default("afplay"),
    /** Seconds of audio around the question's range. No default: the first `listen` asks and saves it. */
    padSec: z.number().min(0).max(60).optional(),
    /** Questions one `listen` round asks at most; the next round asks the rest. */
    roundCap: z.number().int().min(1).max(500).default(12),
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

interface LanguageDefaults {
    ocr: string[];
    render: { unclearLabel: string; readAloudLabel: string; lineLabel: string };
}

const label = z.string().trim().min(1);

/** One spoken language: the Vision OCR languages for screen frames, the transcript's labels, and its word check. */
function languageSchema(defaults: LanguageDefaults) {
    return z.object({
        /** Vision OCR languages for the screen frames of a meeting in this language, in order of preference. */
        ocr: z.array(label).min(1).default(defaults.ocr),
        render: z
            .object({
                /** The word an open passage starts with in a transcript: `[nejasné: "<raw>"; 1) … 2) …]`. */
                unclearLabel: label.default(defaults.render.unclearLabel),
                /** How a quote names its source: `(<readAloudLabel> WikiProposals, <lineLabel> 33)`. */
                readAloudLabel: label.default(defaults.render.readAloudLabel),
                lineLabel: label.default(defaults.render.lineLabel),
            })
            .prefault({}),
        /** The spell provider of this language's word check (`hunspell`, `hunspell-cc0`, `macos`); unset is the default one. */
        wordCheck: label.optional(),
    });
}

/** A language with no block of defaults here: every key is written out. */
const customLanguageSchema = z.object({
    ocr: z.array(label).min(1),
    render: z.object({ unclearLabel: label, readAloudLabel: label, lineLabel: label }),
    wordCheck: label.optional(),
});

/** One block per spoken language. A new one is a block here (or in the file, with every key) and a class in the word check. */
const languagesSchema = z
    .object({
        cs: languageSchema({
            ocr: ["cs-CZ", "en-US"],
            render: { unclearLabel: "nejasné", readAloudLabel: "čte z", lineLabel: "ř." },
        }).prefault({}),
        sk: languageSchema({
            ocr: ["sk-SK", "cs-CZ", "en-US"],
            render: { unclearLabel: "nejasné", readAloudLabel: "číta z", lineLabel: "r." },
        }).prefault({}),
    })
    .catchall(customLanguageSchema);

export type LanguageSettings = z.infer<typeof customLanguageSchema>;

const storedConfigSchema = z
    .object({
        version: z.literal(MEETINGS_CONFIG_VERSION).default(MEETINGS_CONFIG_VERSION),
        global: z
            .object({
                dictionary: dictionaryLevelSchema.prefault({}),
                /** The language meetings are held in: its block in `languages` labels the transcript and reads the screen. */
                language: z.string().trim().min(1).default("cs"),
                capture: captureSchema.prefault({}),
                playback: playbackSchema.prefault({}),
                summary: summarySchema.prefault({}),
                suggest: z
                    .object({
                        /** An item under this confidence that matters (enough words, or a decision) becomes a question. */
                        listenBelow: z.number().min(0).max(1).default(0.6),
                        /** `--with-suggested` applies a suggested item at this confidence or more; a lower one is marked unclear. */
                        applyAbove: z.number().min(0).max(1).default(0.5),
                        /** Questions one `items suggest` run makes at most, speakers and terms together; the rest stay marked. */
                        questionCap: z.number().int().min(1).max(500).default(12),
                    })
                    .prefault({}),
            })
            .prefault({}),
        /** The known projects. `--project` with a new name adds one here. */
        projects: z.record(projectNameSchema, projectSchema).default({}),
        /** One block per transcript source, holding only the keys that source reads. */
        sources: sourcesSchema.prefault({}),
        languages: languagesSchema.prefault({}),
    })
    .superRefine((config, ctx) => {
        if (!(config.global.language in config.languages)) {
            ctx.addIssue({
                code: "custom",
                path: ["global", "language"],
                message: `no block languages.${config.global.language}; known: ${Object.keys(config.languages).join(", ")}`,
            });
        }
    });

type StoredConfig = z.infer<typeof storedConfigSchema>;

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Moves a version 1 config to the version 2 places, in place: `global.render` to `languages.<language>.render`,
 * `global.playback.listen.budget` to `global.suggest.questionCap` and `global.playback.listen.roundCap`, and
 * `projects.<p>.match.wisprflow.folders` to `sources.wisprflow.match.<p>.folders`. A key already in its new place
 * wins. Returns whether anything changed; a version 2 config is left alone.
 */
export function migrateMeetingsConfig(raw: Record<string, unknown>): boolean {
    if (typeof raw.version === "number" && raw.version >= MEETINGS_CONFIG_VERSION) {
        return false;
    }

    const global = isObject(raw.global) ? raw.global : undefined;

    if (global && isObject(global.render)) {
        const language = typeof global.language === "string" ? global.language : "cs";
        const block = objectAt(objectAt(raw, "languages"), language);
        block.render = { ...global.render, ...(isObject(block.render) ? block.render : {}) };
        delete global.render;
    }

    const playback = global && isObject(global.playback) ? global.playback : undefined;
    const listen = playback && isObject(playback.listen) ? playback.listen : undefined;

    if (global && listen && listen.budget !== undefined) {
        const suggest = objectAt(global, "suggest");
        suggest.questionCap ??= listen.budget;
        listen.roundCap ??= listen.budget;
        delete listen.budget;
    }

    for (const [project, settings] of Object.entries(isObject(raw.projects) ? raw.projects : {})) {
        const match = isObject(settings) && isObject(settings.match) ? settings.match : undefined;

        if (!match || !isObject(match.wisprflow)) {
            continue;
        }

        const wispr = objectAt(objectAt(objectAt(raw, "sources"), "wisprflow"), "match");
        wispr[project] ??= match.wisprflow;
        delete match.wisprflow;

        if (Object.keys(match).length === 0 && isObject(settings)) {
            delete settings.match;
        }
    }

    raw.version = MEETINGS_CONFIG_VERSION;
    return true;
}

/** The config as the code reads it: a version 1 shape is migrated first, every default is filled in. */
export const meetingsConfigSchema = z.preprocess((value) => {
    if (!isObject(value)) {
        return value;
    }

    const copy = structuredClone(value);
    migrateMeetingsConfig(copy);
    return copy;
}, storedConfigSchema);

export type MeetingsConfig = z.infer<typeof meetingsConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;

/** The block of a language: the meeting language (`global.language`) by default. */
export function languageSettings(config: Pick<StoredConfig, "global" | "languages">, code?: string): LanguageSettings {
    const wanted = code ?? config.global.language;
    const block = config.languages[wanted];

    if (!block) {
        throw new Error(`No languages.${wanted} block in the meetings config`);
    }

    return block;
}

/** What a recorder takes beyond the shared capture policy: its own block of `capture.recorders`. */
export function recorderSettings(
    capture: MeetingsConfig["global"]["capture"],
    id: FrameRecorderId = capture.backend
): Partial<z.infer<typeof nativeRecorderSchema>> {
    return capture.recorders[id];
}

/** Facts about a meeting that a project's match rules can test. */
export interface ProjectMatchFacts {
    /** The source the meeting came from, with the source's own folders for it. */
    source?: { id: MeetingSourceId; folders: string[] };
    calendar?: string;
    title?: string;
}

/** The folders of each source that put a meeting into `project`, as `{ source, folder }` pairs. */
export function sourceFolders(
    config: MeetingsConfig,
    project: string
): Array<{ source: MeetingSourceId; folder: string }> {
    return MEETING_SOURCE_IDS.flatMap((source) =>
        (config.sources[source].match[project]?.folders ?? []).map((folder) => ({ source, folder }))
    );
}

/** The known projects whose match rules fit these facts, in config order. */
export function matchProjects(config: MeetingsConfig, facts: ProjectMatchFacts): string[] {
    const folders = new Set((facts.source?.folders ?? []).map((name) => name.toLowerCase()));
    const sourceMatch = facts.source ? config.sources[facts.source.id].match : {};
    const title = facts.title?.toLowerCase() ?? "";
    const calendar = facts.calendar?.toLowerCase();

    return Object.entries(config.projects)
        .filter(([name, project]) => {
            const byFolder = (sourceMatch[name]?.folders ?? []).some((folder) => folders.has(folder.toLowerCase()));
            const match = project.match;
            const byCalendar =
                calendar !== undefined &&
                (match?.calendar?.calendars ?? []).some((one) => one.toLowerCase() === calendar);
            const byTitle =
                title !== "" && (match?.calendar?.titles ?? []).some((word) => title.includes(word.toLowerCase()));

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

    /**
     * The config with every default filled in. A missing file is the defaults; an invalid one throws with each issue.
     * A version 1 file is rewritten in the version 2 shape once, under the lock.
     */
    async read(): Promise<MeetingsConfig> {
        let raw = (await this.storage.getConfig<Record<string, unknown>>()) ?? {};

        if (Object.keys(raw).length > 0 && migrateMeetingsConfig(structuredClone(raw))) {
            raw = await this.storage.atomicConfigUpdate<Record<string, unknown>>((current) => {
                if (migrateMeetingsConfig(current)) {
                    const parsed = meetingsConfigSchema.safeParse(current);

                    if (!parsed.success) {
                        throw new Error(formatIssues(parsed.error, this.path));
                    }

                    log.debug({ path: this.path, version: MEETINGS_CONFIG_VERSION }, "meetings config migrated");
                }
            });
        }

        const parsed = meetingsConfigSchema.safeParse(raw);

        if (!parsed.success) {
            throw new Error(formatIssues(parsed.error, this.path));
        }

        return parsed.data;
    }

    /**
     * Changes the file under its lock. `mutate` edits the raw JSON (so keys a person wrote stay as written), and the
     * result must still validate, or nothing is written. A version 1 file is migrated before `mutate` sees it.
     */
    async update(mutate: (raw: Record<string, unknown>) => void): Promise<MeetingsConfig> {
        let validated: MeetingsConfig | undefined;

        await this.storage.atomicConfigUpdate<Record<string, unknown>>((raw) => {
            migrateMeetingsConfig(raw);
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
