import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { cloneOrCopy, type Placement } from "@genesiscz/utils/fs/clone";
import { fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { calendarSchema, type MeetingCalendar } from "@genesiscz/utils/meetings/record";
import { loadRmConfig, moveToTrash, resolveTarget, rmCallerFromRuntime } from "@genesiscz/utils/rm";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import type { Meeting } from "./types";

const { log } = logger.scoped("wisprflow-imported");

const MEETING_FILE = "meeting.json";
/** The export's own files, written by `meetings export`. */
const EXPORT_FILES = [MEETING_FILE, "Summary.md", "Transcript.md"] as const;
/** The app's meeting folder files the evidence reader and the audio readers use. */
export const RAW_FILES = [
    "live.ndjson",
    "refined.ndjson",
    "native-language-evidence.json",
    "audio-devices.json",
    "speakers.observations.ndjson",
    ".mic-retained",
    "upload.ogg",
    "mic.m4a",
] as const;
/** The raw files may sit in the export folder itself or in this sub-folder of it. */
const RAW_SUBFOLDER = "wispr-raw";
/** A meeting id names a folder of the store, so it may not walk out of it. */
const MEETING_ID_RE = /^[\w-]+$/;

const participantSchema = z.object({
    speakerId: z.number().optional(),
    name: z.string(),
    origin: z.string().optional(),
    isSelf: z.boolean().optional(),
});

const entrySchema = z.object({
    id: z.string().optional(),
    startSec: z.number().optional(),
    speakerId: z.number().optional(),
    speaker: z.string(),
    text: z.string(),
});

const meetingSchema = z.object({
    id: z.string().regex(MEETING_ID_RE, "a meeting id of letters, digits, '_' and '-'"),
    title: z.string(),
    start: z.string(),
    end: z.string().optional(),
    modifiedAt: z.string().optional(),
    hasTranscript: z.boolean(),
    shareLink: z.string().optional(),
    folders: z.array(z.object({ id: z.string(), name: z.string() })),
    excerpt: z.string().optional(),
    summary: z.string(),
    notes: z.string(),
    participants: z.array(participantSchema),
    transcript: z.array(entrySchema),
    speakerRenamePending: z.boolean().optional(),
    transcriptGap: z
        .object({ refinedUntilSec: z.number(), liveUntilSec: z.number(), appendedLines: z.number() })
        .nullish()
        .transform((gap) => gap ?? undefined),
});

/** `meeting.json` as `tools wisprflow meetings export` writes it. */
const exportSchema = z.object({
    /** Which source answered on the recording Mac: `local`, `mcp`, or `imported` for a re-export. */
    source: z.string(),
    meeting: meetingSchema,
    calendar: calendarSchema.nullish().transform((calendar) => calendar ?? undefined),
});

export interface ImportedExport {
    source: string;
    meeting: Meeting;
    calendar?: MeetingCalendar;
}

export type ImportStatus = "imported" | "unchanged" | "replaced";

export interface ImportResult {
    status: ImportStatus;
    meetingId: string;
    title: string;
    /** The meeting's folder in the import store. */
    folder: string;
    /** The files put into the store; empty when the same content was there already. */
    copied: Array<{ name: string; from: string; placement: Placement }>;
    /** The known files the export folder lacks. */
    missing: string[];
}

/** A different import of the same meeting is in the store; `--force` replaces it. */
export class ImportConflictError extends Error {
    constructor(
        readonly meetingId: string,
        readonly differing: string[]
    ) {
        super(
            `meeting ${meetingId} is imported already with different content (${differing.join(", ")}); --force replaces it`
        );
        this.name = "ImportConflictError";
    }
}

/** `~/.genesis-tools/wisprflow/imported`: one folder per meeting, laid out like the app's own meeting folder. */
export function importedStoreRoot(): string {
    return toolDataDir("wisprflow", "imported");
}

function parseExport(raw: string, path: string): ImportedExport {
    const parsed = exportSchema.safeParse(SafeJSON.parse(raw));

    if (!parsed.success) {
        throw new Error(`${path} is not a Wispr Flow meeting export: ${z.prettifyError(parsed.error)}`);
    }

    return parsed.data;
}

/** The imported meeting's folder, when the store holds it. */
export function importedMeetingFolder(id: string): string | undefined {
    if (!MEETING_ID_RE.test(id)) {
        return undefined;
    }

    const folder = join(importedStoreRoot(), id);
    return existsSync(join(folder, MEETING_FILE)) ? folder : undefined;
}

/** The imported export of one meeting, or undefined when the store does not hold it. */
export function readImportedExport(id: string): ImportedExport | undefined {
    const folder = importedMeetingFolder(id);

    if (!folder) {
        return undefined;
    }

    const path = join(folder, MEETING_FILE);
    return parseExport(readFileSync(path, "utf8"), path);
}

/** The recording user of an imported meeting: its participant marked as self on the recording Mac. */
export function importedSelfName(meeting: Meeting): string | undefined {
    return meeting.participants.find((person) => person.isSelf)?.name;
}

/** What an imported meeting is read from, as a token; undefined when the store does not hold the meeting. */
export function importedMeetingRevision(id: string): string | undefined {
    const folder = importedMeetingFolder(id);

    if (!folder) {
        return undefined;
    }

    const files = [MEETING_FILE, "live.ndjson", "speakers.observations.ndjson"].map((name) =>
        fileIdentity(join(folder, name))
    );
    return Bun.hash(SafeJSON.stringify(files)).toString(36);
}

function findFile(folder: string, name: string): string | undefined {
    const candidates = [join(folder, name), join(folder, RAW_SUBFOLDER, name)];
    return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sameFile(a: string, b: string): boolean {
    return statSync(a).size === statSync(b).size && sha256(a) === sha256(b);
}

/** The files that differ between a planned import and the stored one, by name. Empty when they hold the same. */
function differences(sources: Map<string, string>, stored: string): string[] {
    const storedNames = readdirSync(stored);
    const extra = storedNames.filter((name) => !sources.has(name));
    const changed = [...sources].filter(([name, from]) => {
        const target = join(stored, name);
        return !existsSync(target) || !sameFile(from, target);
    });
    return [...changed.map(([name]) => name), ...extra].sort();
}

function trash(path: string, rule: string): void {
    const config = loadRmConfig();
    const batch = moveToTrash([{ target: resolveTarget(path, importedStoreRoot()), rule }], {
        config,
        caller: rmCallerFromRuntime(),
        graceMinutes: config.grace.otherMinutes,
    });

    if (!batch || existsSync(path)) {
        throw new Error(`${path} could not be moved to the trash`);
    }
}

/**
 * Copies an export folder of `tools wisprflow meetings export` (with the raw Wispr files beside it or in `wispr-raw/`)
 * into the import store, so a meeting recorded on another Mac and account reads like one of this Mac's. Each file is
 * an APFS clone where the volume allows it. The same content again changes nothing; different content is refused
 * unless `force`, and then the old import goes to the trash.
 */
export function importExport(options: { folder: string; force?: boolean }): ImportResult {
    const metaPath = findFile(options.folder, MEETING_FILE);

    if (!metaPath) {
        throw new Error(`${options.folder} has no ${MEETING_FILE}; export the meeting with 'meetings export' first`);
    }

    const exported = parseExport(readFileSync(metaPath, "utf8"), metaPath);
    const id = exported.meeting.id;
    const sources = new Map<string, string>();
    const missing: string[] = [];

    for (const name of [...EXPORT_FILES, ...RAW_FILES]) {
        const from = findFile(options.folder, name);

        if (from) {
            sources.set(name, from);
        } else {
            missing.push(name);
        }
    }

    const root = importedStoreRoot();
    const target = join(root, id);
    const base = { meetingId: id, title: exported.meeting.title, folder: target, missing };
    const existed = existsSync(target);

    if (existed) {
        const differing = differences(sources, target);

        if (differing.length === 0) {
            log.debug({ id, target }, "the same export is imported already");
            return { status: "unchanged", copied: [], ...base };
        }

        if (!options.force) {
            throw new ImportConflictError(id, differing);
        }
    }

    // Staged beside the target, then renamed into place: a failed copy never leaves a half import behind.
    mkdirSync(root, { recursive: true });
    const staging = join(root, `.${id}.staging-${process.pid}-${Date.now()}`);
    mkdirSync(staging);
    const copied: ImportResult["copied"] = [];

    try {
        for (const [name, from] of sources) {
            const placement = cloneOrCopy({
                source: from,
                destination: join(staging, name),
                mode: 0o600,
                mayCopy: true,
            });
            copied.push({ name, from, placement });
        }

        if (existed) {
            trash(target, "wisprflow-import-replaced");
        }

        renameSync(staging, target);
    } catch (error) {
        if (existsSync(staging)) {
            trash(staging, "wisprflow-import-unfinished");
        }

        throw error;
    }

    log.debug({ id, target, copied: copied.length, missing }, "export imported");
    return { status: existed ? "replaced" : "imported", copied, ...base };
}
