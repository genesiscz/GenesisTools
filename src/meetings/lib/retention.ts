import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { basename, join } from "node:path";
import { PROXY_FILE } from "@app/recorder/lib/proxy";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { transcriptCachePath } from "@genesiscz/utils/recording-editor/project";
import {
    defaultRuleContext,
    graceMinutesFor,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    planRemoval,
    rmCallerFromRuntime,
} from "@genesiscz/utils/rm";
import { RECORDING_MANIFEST } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

const { log } = logger.scoped("meetings-retention");

const DAY_MS = 86_400_000;
/** The capture `capture.retentionDays` removes from a meeting folder, and dates by. The record and its items stay. */
const CAPTURE_PATHS = ["frames", "ocr.jsonl", "audio", "audio.jsonl"] as const;
/**
 * Made from the capture when the meeting opens in the editor: the frame list, the proxy movie (the same screen, with
 * the meeting audio) and its caption cache. They go with the capture; opening the editor rewrites them, so their
 * time dates a meeting only when its capture is already gone.
 */
const DERIVED_PATHS = [RECORDING_MANIFEST, PROXY_FILE, basename(transcriptCachePath(PROXY_FILE))] as const;
/** When the last pass ran, beside the meeting folders. */
export const RETENTION_STAMP_FILE = "retention-last.json";

export interface PrunePlan {
    meetingId: string;
    /**
     * The newest frame, OCR line or sound track of the meeting (its newest editor file when only those are left), as
     * an mtime.
     */
    lastCaptureAt: string;
    paths: string[];
}

export interface PruneResult {
    plans: PrunePlan[];
    /** The trash batch the paths went into, or null when nothing moved. */
    batch: string | null;
}

/** Moves paths into the GenesisTools trash (`tools rm restore <batch>` brings them back). Returns the batch id. */
export type TrashPaths = (paths: string[]) => string | null;

/** Capture folders whose files are written in place, so the folder's own mtime does not move with them. */
const IN_PLACE_FOLDERS = new Set(["audio"]);

/** True for the errors of a path that is no longer there; any other read error is not evidence of age. */
function wentAway(err: unknown): boolean {
    return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/**
 * A path's stat, or null when it went away during the pass (a recorder or another prune removed it). Any other error
 * (a denied or failed read) is thrown, so the pass stops instead of pruning a meeting on incomplete evidence.
 */
function statOrNull(path: string): Stats | null {
    try {
        return statSync(path);
    } catch (err) {
        if (!wentAway(err)) {
            throw err;
        }

        log.debug({ err, path }, "a capture path went away during the retention pass");
        return null;
    }
}

/** A folder's entries, or none when it went away during the pass; any other error is thrown, as in `statOrNull`. */
function namesOrEmpty(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (err) {
        if (!wentAway(err)) {
            throw err;
        }

        log.debug({ err, path }, "a capture folder went away during the retention pass");
        return [];
    }
}

/**
 * The newest change among a meeting's capture paths. Adding or removing a frame moves the `frames/` folder's own
 * mtime, so its thousands of files are not read; audio tracks are written in place, so `audio/` is read file by file.
 */
function newestMtime(paths: string[]): number {
    let newest = 0;
    for (const path of paths) {
        const stat = statOrNull(path);

        if (!stat) {
            continue;
        }

        newest = Math.max(newest, stat.mtimeMs);

        if (stat.isDirectory() && IN_PLACE_FOLDERS.has(basename(path))) {
            for (const name of namesOrEmpty(path)) {
                newest = Math.max(newest, statOrNull(join(path, name))?.mtimeMs ?? 0);
            }
        }
    }
    return newest;
}

/**
 * The meetings whose frames and OCR are older than `days`: their newest capture file changed before the cut-off.
 * Each plan also takes the editor files made from that capture.
 * `skip` is the meeting a recorder is recording now.
 */
export function capturesToPrune(
    store: MeetingStore,
    options: { days: number; now: number; skip?: string }
): PrunePlan[] {
    if (!existsSync(store.root)) {
        return [];
    }

    const cutoff = options.now - options.days * DAY_MS;
    const plans: PrunePlan[] = [];

    for (const entry of readdirSync(store.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === options.skip) {
            continue;
        }

        const folder = store.folder(entry.name);
        const captured = CAPTURE_PATHS.map((name) => join(folder, name)).filter((path) => existsSync(path));
        const derived = DERIVED_PATHS.map((name) => join(folder, name)).filter((path) => existsSync(path));
        const dated = captured.length > 0 ? captured : derived;

        if (dated.length === 0) {
            continue;
        }

        const newest = newestMtime(dated);

        if (newest < cutoff) {
            plans.push({
                meetingId: entry.name,
                lastCaptureAt: new Date(newest).toISOString(),
                paths: [...captured, ...derived],
            });
        }
    }

    return plans;
}

/** The repository's delete helper: the `tools rm` rules and trash, never a plain unlink. A path the rules deny stays. */
export const trashWithRm: TrashPaths = (paths) => {
    const config = loadRmConfig();
    const caller = rmCallerFromRuntime();
    const ctx = defaultRuleContext(config, caller, process.cwd());
    // Automatic retention moves only what the rules allow outright; a path that needs approval stays where it is.
    const plan = planRemoval(paths, ctx).filter((item) => item.verdict.kind === "allow");

    if (plan.length === 0) {
        return null;
    }

    const batch = moveToTrash(
        plan.map((item) => ({ target: item.target, rule: "meetings-retention" })),
        { config, caller, graceMinutes: Math.max(...plan.map((item) => graceMinutesFor(item, ctx))) }
    );
    kickDrainer(config);

    return batch?.id ?? null;
};

/** Moves the frames, OCR and editor files of every meeting past `days` into the trash. */
export function pruneCaptures(
    store: MeetingStore,
    options: { days: number; now?: number; skip?: string; trash?: TrashPaths }
): PruneResult {
    const plans = capturesToPrune(store, { days: options.days, now: options.now ?? Date.now(), skip: options.skip });

    if (plans.length === 0) {
        return { plans, batch: null };
    }

    const batch = (options.trash ?? trashWithRm)(plans.flatMap((plan) => plan.paths));
    log.info(
        { meetings: plans.map((plan) => plan.meetingId), batch, days: options.days },
        "old captures moved to the trash"
    );

    return { plans, batch };
}

function lastPassAt(store: MeetingStore): number {
    const path = join(store.root, RETENTION_STAMP_FILE);

    if (!existsSync(path)) {
        return 0;
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
    const at = parsed && typeof parsed === "object" && "at" in parsed ? parsed.at : undefined;

    return typeof at === "string" ? Date.parse(at) || 0 : 0;
}

/** `pruneCaptures` at most once a day: the watcher calls it on every look, and it runs when a day has passed. */
export function pruneCapturesDaily(
    store: MeetingStore,
    options: { days: number; now?: number; skip?: string; trash?: TrashPaths }
): PruneResult | undefined {
    const now = options.now ?? Date.now();

    if (now - lastPassAt(store) < DAY_MS) {
        return undefined;
    }

    const result = pruneCaptures(store, { ...options, now });
    atomicWriteFileSync(
        join(store.root, RETENTION_STAMP_FILE),
        `${SafeJSON.stringify({ at: new Date(now).toISOString(), meetings: result.plans.length, batch: result.batch })}\n`
    );

    return result;
}
