import { logger } from "@genesiscz/utils/logger";
import { OCR_READS } from "@genesiscz/utils/macos/ocr";
import { FILLER_WORDS, type FillerLists } from "@genesiscz/utils/recording-editor/transcript-cuts";
import { AUDIO_SOURCES, OCR_REGIONS } from "@genesiscz/utils/screen-recorder/control";
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
import { MeetingsConflictError } from "./conflict";
import {
    addPairings,
    type PairedBy,
    type PersonRef,
    pairedPersonSchema,
    removeEntryPairings,
    samePerson,
} from "./people";
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

/** The config shape this code writes. Older files are migrated on the first read (`migrateMeetingsConfig`). */
export const MEETINGS_CONFIG_VERSION = 3;

/**
 * How a meeting finds its project, by the facts every meeting has: its calendar entry, its title and its people. A
 * source's own facts (Wispr folders) sit in `sources.<id>.match`.
 */
const projectMatchSchema = z.object({
    /** Apple Calendar names: an entry in one of them puts the meeting in this project. */
    calendar: z.object({ calendars: strings }).optional(),
    /** Words of the meeting title (version 2 kept them as `calendar.titles`). */
    title: z.object({ words: strings }).optional(),
    /** People paired with this project, each with the sources that paired them. One person can be in several projects. */
    people: z.array(pairedPersonSchema).default([]),
});

const projectSchema = z.object({
    dictionary: dictionaryLevelSchema.optional(),
    match: projectMatchSchema.optional(),
    /** Labels a meeting of this project can carry, to group meetings finer than a project (shop: "Checkout 2.0"). */
    labels: strings,
    /** Where `meetings export` writes this project's polished meeting notes (a vault folder). Unset: it asks. */
    export: z.object({ folder: z.string().trim().min(1) }).optional(),
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
    /** How the kept frames are read by OCR. Tile reads improve small-text recall on wide displays. */
    ocr: z
        .object({
            /** The OCR-only change threshold (0 to 1): a kept frame that changed less keeps the previous frame's text. */
            threshold: z.number().min(0).max(1).default(0),
            /** A kept frame whose changed area holds no text, now or before, keeps the previous frame's text. */
            skipTextless: z.boolean().default(false),
            /** `frame` reads each kept frame whole; `changed` reads only its changed area and keeps the rest. */
            region: z.enum(OCR_REGIONS).default("frame"),
            /** Whole-frame reads or overlapping region tiles without language correction. */
            read: z.enum(OCR_READS).default("tiles"),
        })
        .prefault({}),
    jpegQuality: z.number().min(0.1).max(1).default(0.75),
    /** The longest side of a frame in pixels. Smaller text than this keeps is lost to OCR on a large display. */
    resolutionCap: z.number().int().min(640).max(8192).default(2880),
    /**
     * The watcher moves a meeting's frames, OCR and recorded sound (`frames/`, `ocr.jsonl`, `audio/`, `audio.jsonl`) to the
     * trash this many days after its newest capture file; the meeting record stays.
     */
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
            /**
             * A recording is live while its live transcript changed this recently; this only starts a recording. One
             * stops when the source ends the meeting, never on silence (an older file's `stopAfterSilenceSec` is ignored).
             */
            liveWithinSec: z.number().int().positive().default(30),
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
    fillers: { sounds: string[]; words: string[] };
}

const label = z.string().trim().min(1);

/**
 * The filler words of one language, in the two levels the editor's `cutFillers` knows: `sounds` are never words
 * ("ehm"), `words` are fillers that are also real words ("jako" is "as" in "stejně jako"), cut only at level `all`.
 */
function fillersSchema(defaults: { sounds: string[]; words: string[] }) {
    return z.object({
        sounds: z.array(label).default(defaults.sounds),
        words: z.array(label).default(defaults.words),
    });
}

/** The default lists of a language the code ships (`FILLER_WORDS`), copied so a caller cannot change the table. */
function shippedFillers(code: string): { sounds: string[]; words: string[] } {
    const list = FILLER_WORDS[code];
    return { sounds: [...(list?.sounds ?? [])], words: [...(list?.words ?? [])] };
}

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
        /** The words `recorder cut-fillers` cuts for a transcript in this language (the editor's `cutFillers` op). */
        fillers: fillersSchema(defaults.fillers).prefault({}),
    });
}

/** A language with no block of defaults here: every key is written out. */
const customLanguageSchema = z.object({
    ocr: z.array(label).min(1),
    render: z.object({ unclearLabel: label, readAloudLabel: label, lineLabel: label }),
    wordCheck: label.optional(),
    /** A level left out is the shipped list of that code (`FILLER_WORDS`), or none for a code the editor has no list for. */
    fillers: z.object({ sounds: z.array(label).optional(), words: z.array(label).optional() }).optional(),
});

type LanguageBlock = z.output<ReturnType<typeof languageSchema>>;

/** One block per spoken language. A new one is a block here (or in the file, with every key) and a class in the word check. */
const languagesSchema = z
    .object({
        cs: languageSchema({
            ocr: ["cs-CZ", "en-US"],
            render: { unclearLabel: "nejasné", readAloudLabel: "čte z", lineLabel: "ř." },
            fillers: shippedFillers("cs"),
        }).prefault({}),
        sk: languageSchema({
            ocr: ["sk-SK", "cs-CZ", "en-US"],
            render: { unclearLabel: "nejasné", readAloudLabel: "číta z", lineLabel: "r." },
            fillers: shippedFillers("sk"),
        }).prefault({}),
    })
    .catchall(customLanguageSchema)
    // Filled here, not by each reader: `config show` (the Settings window) then lists what a cut removes, `en` included,
    // and a write of one level keeps the other level's shipped list. Writes edit the raw file, so nothing is stored.
    .transform(({ cs, sk, ...custom }): Record<string, LanguageBlock> & { cs: LanguageBlock; sk: LanguageBlock } => {
        const filled: Record<string, LanguageBlock> = {};

        for (const [code, block] of Object.entries(custom)) {
            const shipped = shippedFillers(code);
            filled[code] = {
                ...block,
                fillers: {
                    sounds: block.fillers?.sounds ?? shipped.sounds,
                    words: block.fillers?.words ?? shipped.words,
                },
            };
        }

        return { ...filled, cs, sk };
    });

export type LanguageSettings = LanguageBlock;

/** How a meeting without a project gets one. */
const assignSchema = z.object({
    /** Ask in the decision inbox once for each meeting that has no project when its sources have linked. */
    ask: z.boolean().default(true),
    /** The watcher asks about meetings that started this recently; an older one is asked with `meetings assign ask`. */
    lookbackHours: z.number().int().positive().default(48),
    /** The most ranked project proposals one question lists. */
    maxProposals: z.number().int().min(1).max(20).default(5),
    /** A calendar entry counts as the meeting's when it overlaps it, or starts this many minutes before or after it. */
    calendarSlackMin: z.number().int().min(0).max(120).default(15),
    /** Calendar entries that start this many hours before a meeting can still cover it (never less than the slack). */
    calendarLookbehindHours: z.number().int().min(0).max(48).default(3),
    /** A meeting waits this many days for the owner to move it into a source folder (Wispr); then the folder step ends. */
    folderWaitDays: z.number().int().positive().max(365).default(14),
    /** A project question whose post failed is posted again after this many minutes, so a broken inbox is not hit on every look. */
    retryFailedMin: z
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .default(10),
});

/** What an export does with a note that holds edits: see `global.export.ifEdited`. */
export const EXPORT_IF_EDITED = ["beside", "refuse", "replace"] as const;
export type ExportIfEdited = (typeof EXPORT_IF_EDITED)[number];

const storedConfigSchema = z
    .object({
        /** A newer version than this code writes still reads: its keys this code knows, the rest stay in the file. */
        version: z.number().int().min(MEETINGS_CONFIG_VERSION).default(MEETINGS_CONFIG_VERSION),
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
                        /** `skip`: no meaning after words a plain code name only restates ("entity data" `EntityData`). */
                        restatedIdentifiers: z.enum(["skip", "mark"]).default("skip"),
                    })
                    .prefault({}),
                assign: assignSchema.prefault({}),
                export: z
                    .object({
                        /**
                         * What `meetings export` does when the note it would replace holds edits the last export did
                         * not write: `beside` writes the new note next to it, `refuse` writes nothing, `replace`
                         * overwrites the edits.
                         */
                        ifEdited: z.enum(EXPORT_IF_EDITED).default("beside"),
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
 * Version 1 to 2: `global.render` to `languages.<language>.render`, `global.playback.listen.budget` to
 * `global.suggest.questionCap` and `global.playback.listen.roundCap`, and `projects.<p>.match.wisprflow.folders` to
 * `sources.wisprflow.match.<p>.folders`. A key already in its new place wins.
 */
function migrateToV2(raw: Record<string, unknown>): void {
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
}

/**
 * Version 2 to 3: `projects.<p>.match.calendar.titles` to `projects.<p>.match.title.words`, since the words test the
 * meeting title from any source, not the calendar. Words already in the new place stay first; the old ones fill in.
 */
function migrateToV3(raw: Record<string, unknown>): void {
    for (const settings of Object.values(isObject(raw.projects) ? raw.projects : {})) {
        const match = isObject(settings) && isObject(settings.match) ? settings.match : undefined;
        const calendar = match && isObject(match.calendar) ? match.calendar : undefined;

        if (!match || !calendar || !Array.isArray(calendar.titles)) {
            continue;
        }

        const title = objectAt(match, "title");
        const words = Array.isArray(title.words) ? title.words : [];
        title.words = [...new Set([...words, ...calendar.titles])];
        delete calendar.titles;

        if (Object.keys(calendar).length === 0) {
            delete match.calendar;
        }
    }
}

/**
 * Moves an older config to the current places, in place, one version step at a time. A file without a version is
 * version 1. Returns whether anything changed; a current config is left alone, so a second run changes nothing.
 */
export function migrateMeetingsConfig(raw: Record<string, unknown>): boolean {
    const version = typeof raw.version === "number" ? raw.version : 1;

    if (version >= MEETINGS_CONFIG_VERSION) {
        return false;
    }

    if (version < 2) {
        migrateToV2(raw);
    }

    migrateToV3(raw);
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

/**
 * The filler lists the editor cuts with: the shipped list of each code (`FILLER_WORDS`, so `en` works without a
 * block), each replaced by the `fillers` of the same code in `languages`. A custom language without `fillers` keeps
 * the shipped list of its code, or has none.
 */
export function fillerListsOf(languages: MeetingsConfig["languages"]): FillerLists {
    const lists: FillerLists = { ...FILLER_WORDS };

    for (const [code, block] of Object.entries(languages)) {
        const own = block?.fillers;

        if (own) {
            lists[code] = { sounds: own.sounds, words: own.words };
        }
    }

    return lists;
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
                title !== "" && (match?.title?.words ?? []).some((word) => title.includes(word.toLowerCase()));

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
     * An older file is rewritten in the current shape once, under the lock.
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

    /**
     * Adds or replaces the entry for `entry.value` in one dictionary level. `ifAbsent`: only add it; an entry with that
     * value in the level (made again since an Undo's remove) is refused with `dictionary-exists`.
     */
    async putDictionaryEntry(
        scope: DictionaryScope,
        entry: DictionaryEntry,
        options: { ifAbsent?: boolean } = {}
    ): Promise<MeetingsConfig> {
        return this.putDictionaryEntries(scope, [entry], options);
    }

    /** Adds or replaces several entries in one level, in one write. `ifAbsent`: see `putDictionaryEntry`. */
    async putDictionaryEntries(
        scope: DictionaryScope,
        added: DictionaryEntry[],
        options: { ifAbsent?: boolean } = {}
    ): Promise<MeetingsConfig> {
        const values = new Set(added.map((entry) => entry.value));

        return this.update((raw) => {
            const level = dictionaryAt(raw, scope);
            const entries = Array.isArray(level.entries) ? (level.entries as Array<{ value?: unknown }>) : [];
            const present = options.ifAbsent
                ? entries.find((existing) => typeof existing.value === "string" && values.has(existing.value))
                : undefined;

            if (present) {
                throw new MeetingsConflictError(
                    "dictionary-exists",
                    `${String(present.value)} is in the ${scope.kind === "project" ? `project ${scope.project}` : "global"} dictionary again; it was left as it is`
                );
            }

            level.entries = [
                ...entries.filter((existing) => typeof existing.value !== "string" || !values.has(existing.value)),
                ...added,
            ];
        });
    }

    /**
     * Replaces the entry for `previous` with `entry` (a renamed entry is a new value) in one write, in its place. The
     * whole config must still validate, so a refused entry leaves `previous` as it was.
     */
    async replaceDictionaryEntry(
        scope: DictionaryScope,
        previous: string,
        entry: DictionaryEntry
    ): Promise<MeetingsConfig> {
        return this.update((raw) => {
            const level = dictionaryAt(raw, scope);
            const entries = Array.isArray(level.entries) ? (level.entries as Array<{ value?: unknown }>) : [];
            const at = entries.findIndex((existing) => existing.value === previous);
            const kept = entries.filter((existing) => existing.value !== previous && existing.value !== entry.value);
            kept.splice(at === -1 ? kept.length : Math.min(at, kept.length), 0, entry);
            level.entries = kept;
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

    /** Adds and removes known labels of a project; the project joins the known ones. Returns its labels. */
    async setProjectLabels(project: string, change: { add?: string[]; remove?: string[] }): Promise<string[]> {
        projectNameSchema.parse(project);
        const config = await this.update((raw) => {
            const settings = objectAt(objectAt(raw, "projects"), project);
            const remove = new Set((change.remove ?? []).map((label) => label.trim().toLowerCase()));
            const current = stringList(settings.labels).filter((label) => !remove.has(label.toLowerCase()));
            const added = (change.add ?? []).map((label) => label.trim()).filter((label) => label.length > 0);
            settings.labels = mergeLabels(current, added);
        });

        return config.projects[project]?.labels ?? [];
    }

    /** Pairs people with a project through one source (a calendar entry or a manual pairing). */
    async pairPeople(options: { project: string; people: PersonRef[]; by: PairedBy }): Promise<MeetingsConfig> {
        projectNameSchema.parse(options.project);

        return this.update((raw) => {
            const match = objectAt(objectAt(objectAt(raw, "projects"), options.project), "match");
            match.people = addPairings(rawPeople(match.people), options.people, options.by);
        });
    }

    /** Removes the pairings one calendar entry made, in every project; a person another source pairs stays. */
    async unpairEntry(
        entryId: string
    ): Promise<Array<{ project: string; name: string; email?: string; left: boolean }>> {
        const removed: Array<{ project: string; name: string; email?: string; left: boolean }> = [];

        await this.update((raw) => {
            for (const [project, settings] of Object.entries(objectAt(raw, "projects"))) {
                const match = isObject(settings) && isObject(settings.match) ? settings.match : undefined;

                if (!match || match.people === undefined) {
                    continue;
                }

                const result = removeEntryPairings(rawPeople(match.people), entryId);
                match.people = result.people;
                removed.push(...result.removed.map((person) => ({ project, ...person })));
            }
        });

        log.debug({ entryId, removed: removed.length }, "calendar entry unpaired");
        return removed;
    }

    /** Removes a person from a project, whatever paired them. Returns false when they were not paired with it. */
    async unpairPerson(project: string, person: PersonRef): Promise<boolean> {
        let removed = false;

        await this.update((raw) => {
            const settings = objectAt(raw, "projects")[project];
            const match = isObject(settings) && isObject(settings.match) ? settings.match : undefined;

            if (!match) {
                return;
            }

            const people = rawPeople(match.people);
            const kept = people.filter((existing) => !samePerson(existing, person));
            removed = kept.length !== people.length;
            match.people = kept;
        });

        return removed;
    }

    /** Pairs a source's folder with a project: a meeting in it then goes to the project. False when it was paired. */
    async addSourceFolder(source: MeetingSourceId, project: string, folder: string): Promise<boolean> {
        projectNameSchema.parse(project);
        let added = false;

        await this.update((raw) => {
            objectAt(objectAt(raw, "projects"), project);
            const match = objectAt(objectAt(objectAt(objectAt(raw, "sources"), source), "match"), project);
            const folders = stringList(match.folders);
            added = !folders.some((known) => known.toLowerCase() === folder.toLowerCase());
            match.folders = added ? [...folders, folder] : folders;
        });

        return added;
    }
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Labels in their first spelling, compared without case. */
export function mergeLabels(current: string[], added: string[]): string[] {
    const merged = [...current];

    for (const label of added) {
        if (!merged.some((known) => known.toLowerCase() === label.toLowerCase())) {
            merged.push(label);
        }
    }

    return merged;
}

function rawPeople(value: unknown): z.infer<typeof pairedPersonSchema>[] {
    if (value === undefined) {
        return [];
    }

    return z.array(pairedPersonSchema).parse(value);
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
