import { readFile, writeFile } from "node:fs/promises";
import { logger } from "@app/logger";
import { parseMarkers } from "./markers";
import type { Decision } from "./unapply-session";

const { log } = logger.scoped("stash:decisions");

/**
 * Outcome of attempting to apply a decision to a file region.
 * - `applied`: marker was found and the region was removed (or no-op for `skip`)
 * - `marker-missing`: marker not found at the requested hunkIndex — caller must treat the
 *   application as still active for that region (PR #222 t28: prevents DB from claiming the stash
 *   is unapplied while the user's code still has the wrapped block).
 */
export type DecisionOutcome = "applied" | "marker-missing";

export async function applyDecisionToCode(args: {
    filePath: string;
    regionName: string;
    /**
     * 1-based index within the markers of `regionName` in this file. `apply` wraps every hunk with
     * the same stash name, so a file with N hunks has N identical markers — we must pick the
     * Nth one, not the first. Callers must process per-file regions back-to-front so each removal
     * doesn't shift the indices of later regions.
     */
    hunkIndex: number;
    decision: Exclude<Decision, null>;
}): Promise<DecisionOutcome> {
    if (args.decision === "skip") {
        return "applied";
    }
    const content = await readFile(args.filePath, "utf8");
    const markers = parseMarkers(content);
    const byName = markers.filter((x) => x.name === args.regionName);
    const m = byName[args.hunkIndex - 1];
    if (!m) {
        log.warn(
            { filePath: args.filePath, regionName: args.regionName, hunkIndex: args.hunkIndex, found: byName.length },
            "no marker at requested hunkIndex; file may have been edited externally"
        );
        return "marker-missing";
    }
    const lines = content.split("\n");
    const before = lines.slice(0, m.startLine - 1);
    const after = lines.slice(m.endLine);
    await writeFile(args.filePath, [...before, ...after].join("\n"));
    return "applied";
}
