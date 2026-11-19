import type { WatchDriverId } from "@genesiscz/utils/fs/watch-driver/registry";
import type { StatusEntry } from "@genesiscz/utils/git/porcelain";

export const STATUS_MODE_IDS = ["git", "snapshot", "narrow-git"] as const;
export type StatusModeId = (typeof STATUS_MODE_IDS)[number];
export type StatusPhase = "pre" | "post";
/** "deletions": the pre phase of a read-only command needs the deleted tracked entries only. */
export type StatusNeed = "deletions" | "all";

export interface StatusView {
    head: string | null;
    entries: StatusEntry[];
}

export interface StatusCost {
    cpuMs: number;
    wallMs: number;
    gitSpawns: number;
    serviceCpuMs: number | null;
    fullStatus: boolean;
}

export interface StatusRequest {
    phase: StatusPhase;
    root: string;
    need: StatusNeed;
    head: string | null;
    mark: string | null;
}

export type StatusAnswer =
    | { state: "ok"; view: StatusView; mark: string | null; source: string; cost: StatusCost }
    /** `reason`: a short kebab-case code of the arm. */
    | { state: "unavailable"; reason: string; cost: StatusCost };

export interface StatusArm {
    readonly id: string;
    readonly mode: StatusModeId;
    observe(request: StatusRequest): Promise<StatusAnswer>;
}

export interface SnapshotModeSettings {
    driver: WatchDriverId;
    shadowDrivers: WatchDriverId[];
    deadlineMs: number;
    fenceMs: number;
}

export interface StatusModeSettings {
    git: Record<string, never>;
    snapshot: SnapshotModeSettings;
    "narrow-git": Record<string, never>;
}

export interface StatusModeModule<Settings> {
    /** The arm whose answer the hooks use when this mode is active. */
    primary(settings: Settings): StatusArm;
    /** More arms of this mode that run only in shadow (the snapshot mode: one per `shadowDrivers` entry). */
    variants(settings: Settings): StatusArm[];
}

export interface DiffStatusConfig {
    /** The mode whose answer the hooks use, by the shape of the command. Default: both "git". */
    active: { read: StatusModeId; write: StatusModeId };
    /** Modes that also run for the same call. Their answers are recorded and never used. Default: none. */
    shadow: { modes: StatusModeId[]; every: number; budgetMs: number };
    modes: StatusModeSettings;
}

export const NO_COST: StatusCost = { cpuMs: 0, wallMs: 0, gitSpawns: 0, serviceCpuMs: null, fullStatus: false };

/** An arm that is not built yet: it always answers `unavailable` with `not-built`, so the hooks use Git. */
export function unbuiltArm(id: string, mode: StatusModeId): StatusArm {
    return { id, mode, observe: async () => ({ state: "unavailable", reason: "not-built", cost: NO_COST }) };
}
