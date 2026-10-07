import { chmod, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { confinedPath, rewriteConfinedText } from "./apply-recovery";
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
    projectRoot?: string;
    regionName: string;
    /**
     * 1-based index within the markers of `regionName` in this file. `apply` wraps every hunk with
     * the same stash name, so a file with N hunks has N identical markers — we must pick the
     * Nth one, not the first. Callers must process per-file regions back-to-front so each removal
     * doesn't shift the indices of later regions.
     */
    hunkIndex: number;
    decision: Exclude<Decision, null>;
    preImage?: string[];
    expectedPostImage?: string;
    oldNoNewline?: boolean;
    deletedFile?: boolean;
    /** Mode of the file before the apply; a recreated deleted file gets it back exactly. */
    fileMode?: number;
}): Promise<DecisionOutcome> {
    if (args.decision === "skip") {
        return "applied";
    }
    if (!args.preImage) {
        throw new Error("Missing stash pre-image; preserve the session for recovery instead of deleting baseline code");
    }
    const preImage = args.preImage;
    const root = args.projectRoot ?? dirname(args.filePath);
    const file = relative(root, args.filePath);
    if (args.deletedFile) {
        const absolute = await confinedPath(root, file);
        const restored = preImage.join("\n") + (args.oldNoNewline ? "" : "\n");
        if (args.fileMode === undefined) {
            await writeFile(absolute, restored, { flag: "wx" });
            return "applied";
        }

        // The create mode passes through the umask; chmod sets the saved mode exactly.
        await writeFile(absolute, restored, { flag: "wx", mode: 0o600 });
        await chmod(absolute, args.fileMode);
        return "applied";
    }
    let outcome: DecisionOutcome = "applied";
    await rewriteConfinedText({
        root,
        file,
        transform: (content) => {
            const markers = parseMarkers(content);
            const byName = markers.filter((x) => x.name === args.regionName);
            const m = byName[args.hunkIndex - 1];
            if (!m) {
                log.warn(
                    {
                        filePath: args.filePath,
                        regionName: args.regionName,
                        hunkIndex: args.hunkIndex,
                        found: byName.length,
                    },
                    "no marker at requested hunkIndex; file may have been edited externally"
                );
                outcome = "marker-missing";
                return content;
            }
            const lines = content.split("\n");
            const before = lines.slice(0, m.startLine - 1);
            const after = lines.slice(m.endLine);
            const currentRegion = lines.slice(m.contentStartLine - 1, m.contentEndLine).join("\n");
            if (args.expectedPostImage !== undefined && currentRegion !== args.expectedPostImage) {
                throw new Error(`Stash region changed after the decision was recorded: ${args.filePath}`);
            }
            if (args.oldNoNewline && after.length === 1 && after[0] === "") {
                after.pop();
            }
            return [...before, ...preImage, ...after].join("\n");
        },
    });
    return outcome;
}
