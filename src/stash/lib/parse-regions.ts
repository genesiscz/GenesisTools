export interface ParsedRegion {
    regionName: string | null;
    filePath: string;
    hunkIndex: number;
    startMarkerPresent: boolean;
    lineCount: number;
}

/**
 * Parse a unified diff patch string and return one `ParsedRegion` per hunk that contains at least
 * one added (`+`) line. Hunks with only context/removed lines are skipped.
 *
 * If any added line inside a hunk contains `#region @stash:<name>`, the region is tagged with
 * that name (`regionName` + `startMarkerPresent = true`).
 *
 * `hunkIndex` is 1-based, resetting to 1 on each new file (`+++ b/...` header).
 */
export function parseRegionsFromPatch(patch: string): ParsedRegion[] {
    const out: ParsedRegion[] = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let hunkIndex = 0;
    let addedCount = 0;
    let regionName: string | null = null;
    let startMarkerPresent = false;

    const flush = () => {
        if (currentFile && addedCount > 0) {
            out.push({ regionName, filePath: currentFile, hunkIndex, startMarkerPresent, lineCount: addedCount });
        }

        addedCount = 0;
        regionName = null;
        startMarkerPresent = false;
    };

    for (const line of lines) {
        const fileMatcher = /^\+\+\+ b\/(.+)$/.exec(line);

        if (fileMatcher) {
            flush();
            currentFile = fileMatcher[1] ?? null;
            hunkIndex = 0;
            continue;
        }

        if (line.startsWith("@@")) {
            flush();
            hunkIndex++;
            continue;
        }

        if (line.startsWith("+") && !line.startsWith("+++")) {
            addedCount++;
            const markerMatch = /#region\s+@stash:([\w.-]+)/.exec(line);

            if (markerMatch?.[1]) {
                regionName = markerMatch[1];
                startMarkerPresent = true;
            }
        }
    }

    flush();
    return out;
}
