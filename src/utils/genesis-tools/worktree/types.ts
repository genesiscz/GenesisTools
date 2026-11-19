import type { WatchDriverId } from "../../fs/watch-driver/registry";
import type { WatchChange } from "../../fs/watch-driver/types";
import type { StatusEntry } from "../../git/porcelain";
import type { InventoryCost, InventoryCounters, ReseedReason } from "../../git/status-inventory";

export type WorktreeDriverId = WatchDriverId;

/** Plain types of the `worktree.*` service methods; the zod twins live in `service/api.ts`. */
export interface WorktreeSnapshotParams {
    root: string;
    driver: WorktreeDriverId;
    since?: string;
    fenceMs?: number;
}

export const WORKTREE_UNAVAILABLE = [
    "no-driver",
    "unsupported-root",
    "opening",
    "fence-timeout",
    "not-a-worktree",
    "over-capacity",
    "git-failed",
] as const;
export type WorktreeUnavailable = (typeof WORKTREE_UNAVAILABLE)[number];

export type WorktreeSnapshot =
    | {
          state: "ok";
          /** `v1:<driver>:<instance>:<root generation>:<clock>`. A client stores it and sends it back, never reads it. */
          mark: string;
          head: string | null;
          entries: StatusEntry[];
          source: "inventory" | "seed" | "reseed";
          reseed?: ReseedReason;
          changed: WatchChange[] | null;
          verifiedMsAgo: number;
          cost: InventoryCost;
      }
    | { state: "unavailable"; reason: WorktreeUnavailable };

export interface WorktreeWatcher {
    root: string;
    driver: WorktreeDriverId;
    openedAt: string;
    lastAnswerAt: string | null;
    instance: string;
    counters: InventoryCounters;
}
