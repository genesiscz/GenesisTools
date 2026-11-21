import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { cloneOrCopy, type Placement } from "@genesiscz/utils/fs/clone";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { calendarSchema, type MeetingCalendar } from "@genesiscz/utils/meetings/record";
import { loadRmConfig, moveToTrash, resolveTarget, rmCallerFromRuntime } from "@genesiscz/utils/rm";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
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

/** The imported meeting's folder, when the store (`root`, the default store when absent) holds it. */
export function importedMeetingFolder(id: string, root: string = importedStoreRoot()): string | undefined {
    if (!MEETING_ID_RE.test(id)) {
        return undefined;
    }

    const folder = join(root, id);
    return existsSync(join(folder, MEETING_FILE)) ? folder : undefined;
}

/**
 * Parsed exports by the identity of their `meeting.json`: one open of an imported meeting asks for it several times
 * (the meeting, its evidence, its calendar), and each ask would parse every transcript line again.
 */
const parsedExports = new FileIdentityCache<ImportedExport>({ limit: 32 });

/** The imported export of one meeting, or undefined when the store (`root`, the default when absent) does not hold it. */
export function readImportedExport(id: string, root: string = importedStoreRoot()): ImportedExport | undefined {
    const folder = importedMeetingFolder(id, root);

    if (!folder) {
        return undefined;
    }

    const path = join(folder, MEETING_FILE);
    const identity = fileIdentity(path);
    const cached = parsedExports.get(path, identity);

    if (cached) {
        // A copy: a caller may change what it was given, and the next caller must still get the file's content.
        return structuredClone(cached);
    }

    const parsed = parseExport(readFileSync(path, "utf8"), path);

    if (identity) {
        parsedExports.set(path, identity, structuredClone(parsed));
    }

    return parsed;
}

/** The recording user of an imported meeting: its participant marked as self on the recording Mac. */
export function importedSelfName(meeting: Meeting): string | undefined {
    return meeting.participants.find((person) => person.isSelf)?.name;
}

/** Who recorded an imported meeting: someone at another Mac, named when the export marks its self. */
export function importedRecordedBy(meeting: Meeting): { owner: false; person?: string } {
    const person = importedSelfName(meeting);
    return { owner: false, ...(person ? { person } : {}) };
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

function sameFile(a: string, b: string): boolean {
    return statSync(a).size === statSync(b).size && sha256File(a) === sha256File(b);
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

/** A replaced import is moved here first and goes to the trash only once its replacement is in place. */
function asidePrefix(id: string): string {
    return `.${id}.replaced-`;
}

/** A replacement that was cut off between its two renames left the old import aside: it comes back. */
function restoreInterrupted(root: string, id: string, target: string): void {
    if (existsSync(target) || !existsSync(root)) {
        return;
    }

    const aside = readdirSync(root)
        .filter((name) => name.startsWith(asidePrefix(id)))
        .sort()
        .at(-1);

    if (aside) {
        renameSync(join(root, aside), target);
        log.warn({ id, aside }, "an interrupted replacement left the previous import aside; it is restored");
    }
}

/**
 * Copies an export folder of `tools wisprflow meetings export` (with the raw Wispr files beside it or in `wispr-raw/`)
 * into the import store, so a meeting recorded on another Mac and account reads like one of this Mac's. Each file is
 * an APFS clone where the volume allows it. The same content again changes nothing; different content is refused
 * unless `force`, and then the old import goes to the trash once the new one is in place. Imports of one meeting
 * take turns (a lock per meeting id), and a replacement that cannot be published puts the old import back.
 */
export async function importExport(options: { folder: string; force?: boolean }): Promise<ImportResult> {
    const metaPath = findFile(options.folder, MEETING_FILE);

    if (!metaPath) {
        throw new Error(`${options.folder} has no ${MEETING_FILE}; export the meeting with 'meetings export' first`);
    }

    const exported = parseExport(readFileSync(metaPath, "utf8"), metaPath);
    const root = importedStoreRoot();
    mkdirSync(root, { recursive: true });
    return withFileLock(join(root, `.${exported.meeting.id}.lock`), async () => importLocked(options, exported), {
        timeoutMs: 60_000,
    });
}

function importLocked(options: { folder: string; force?: boolean }, exported: ImportedExport): ImportResult {
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
    restoreInterrupted(root, id, target);
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
    const stamp = `${process.pid}-${Date.now()}`;
    const staging = join(root, `.${id}.staging-${stamp}`);
    const aside = existed ? join(root, `${asidePrefix(id)}${stamp}`) : undefined;
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

        if (aside) {
            renameSync(target, aside);
        }

        try {
            renameSync(staging, target);
        } catch (error) {
            if (aside) {
                renameSync(aside, target);
            }

            throw error;
        }
    } catch (error) {
        if (existsSync(staging)) {
            trash(staging, "wisprflow-import-unfinished");
        }

        throw error;
    }

    if (aside) {
        try {
            trash(aside, "wisprflow-import-replaced");
        } catch (error) {
            // The new import is in place; the old one stays aside, hidden, until it is moved by hand.
            log.warn({ error, aside }, "the replaced import could not be moved to the trash");
        }
    }

    log.debug({ id, target, copied: copied.length, missing }, "export imported");
    return { status: existed ? "replaced" : "imported", copied, ...base };
}
