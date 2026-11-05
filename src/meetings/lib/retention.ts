import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import {
    defaultRuleContext,
    graceMinutesFor,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    planRemoval,
    rmCallerFromRuntime,
} from "@genesiscz/utils/rm";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

const { log } = logger.scoped("meetings-retention");

const DAY_MS = 86_400_000;
/** What `capture.retentionDays` removes from a meeting folder. The meeting record and its items stay. */
const CAPTURE_PATHS = ["frames", "ocr.jsonl"] as const;
/** When the last pass ran, beside the meeting folders. */
export const RETENTION_STAMP_FILE = "retention-last.json";

export interface PrunePlan {
    meetingId: string;
    /** The newest frame or OCR line of the meeting, as an mtime. */
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

function newestMtime(paths: string[]): number {
    return Math.max(...paths.map((path) => statSync(path).mtimeMs));
}

/**
 * The meetings whose frames and OCR are older than `days`: their newest capture file changed before the cut-off.
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
        const paths = CAPTURE_PATHS.map((name) => join(folder, name)).filter((path) => existsSync(path));

        if (paths.length === 0) {
            continue;
        }

        const newest = newestMtime(paths);

        if (newest < cutoff) {
            plans.push({ meetingId: entry.name, lastCaptureAt: new Date(newest).toISOString(), paths });
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

/** Moves the frames and OCR of every meeting past `days` into the trash. */
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
