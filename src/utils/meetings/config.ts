import { logger } from "@genesiscz/utils/logger";
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

const captureSchema = z.object({
    /** Frames per second while the screen changes. */
    activeFps: z.number().positive().default(1),
    /** Frames per second while it does not. */
    idleFps: z.number().positive().default(0.1),
    /** The share of the screen that must change for a new frame (0 to 1). */
    threshold: z.number().min(0).max(1).default(0.02),
    jpegQuality: z.number().min(0.1).max(1).default(0.6),
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

export const meetingsConfigSchema = z.object({
    version: z.literal(1).default(1),
    global: z
        .object({
            dictionary: dictionaryLevelSchema.prefault({}),
            capture: captureSchema.prefault({}),
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
        return this.update((raw) => {
            const level = dictionaryAt(raw, scope);
            const entries = Array.isArray(level.entries) ? (level.entries as Array<{ value?: unknown }>) : [];
            level.entries = [...entries.filter((existing) => existing.value !== entry.value), entry];
        });
    }

    /** Sets how abbreviations expand on one level. */
    async setAbbrExpansion(scope: DictionaryScope, mode: AbbrExpansion): Promise<MeetingsConfig> {
        return this.update((raw) => {
            dictionaryAt(raw, scope).abbrExpansion = mode;
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
