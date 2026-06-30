import { logger } from "@app/logger";

const { log } = logger.scoped("stash:region-split");

export interface SplitRegion {
    /** Author region name from `// #region @stash:<name>`, or null if this is an anonymous slice (no enclosing markers). */
    name: string | null;
    filePath: string;
    /** 1-indexed slot within the file (sequential across both named and anonymous regions). */
    hunkIndex: number;
    /** The accumulated `+` content for this region (one line per element, no leading `+`). */
    contentLines: string[];
}

interface RawHunk {
    filePath: string;
    addedLines: string[];
}

/**
 * Given a list of raw hunks (post-image `+` lines only, grouped by file), split each
 * hunk at author-marker boundaries. Each `// #region @stash:<name>` opens a named slice;
 * `// #endregion @stash:<name>` closes it. Lines outside any open marker form anonymous
 * slices (one per gap). This produces a more granular region list than v1's "one region
 * per hunk."
 *
 * Backwards-compat: a hunk with no markers becomes ONE anonymous region containing all
 * its added lines — same observable behavior as v1's per-hunk model.
 */
export function splitHunksAtMarkers(rawHunks: RawHunk[]): SplitRegion[] {
    const out: SplitRegion[] = [];
    const hunkIndexByFile = new Map<string, number>();
    const OPEN_RE = /#region\s+@stash:([\w.-]+)/;
    const CLOSE_RE = /#endregion\s+@stash:([\w.-]+)/;

    for (const hunk of rawHunks) {
        let currentName: string | null = null;
        let currentContent: string[] = [];

        const flush = () => {
            if (currentContent.length > 0) {
                const ix = (hunkIndexByFile.get(hunk.filePath) ?? 0) + 1;
                hunkIndexByFile.set(hunk.filePath, ix);
                out.push({
                    name: currentName,
                    filePath: hunk.filePath,
                    hunkIndex: ix,
                    contentLines: [...currentContent],
                });
                currentContent = [];
            }
        };

        for (const line of hunk.addedLines) {
            const openMatch = OPEN_RE.exec(line);

            if (openMatch?.[1]) {
                // Flush any anonymous lines BEFORE this open marker as a separate region.
                if (currentName === null) {
                    flush();
                }
                currentName = openMatch[1];
                currentContent.push(line);
                continue;
            }

            const closeMatch = CLOSE_RE.exec(line);

            if (closeMatch?.[1] && closeMatch[1] === currentName) {
                currentContent.push(line);
                flush();
                currentName = null;
                continue;
            }

            currentContent.push(line);
        }

        flush(); // emit trailing content (anonymous or unterminated-named)
    }

    log.debug({ inHunks: rawHunks.length, outRegions: out.length }, "split hunks at markers");
    return out;
}
