/**
 * Strip apply-time region markers from the patch (so a save of an applied stash doesn't re-include
 * the wrapper) AND fix up the surrounding `@@ -a,b +c,d @@` hunk counts. The contract: drop opener
 * lines that carry a JSON metadata blob (apply-time form) AND their matching `#endregion @stash:NAME`
 * closer with the same name; preserve bare author markers (no JSON) so manually annotated regions
 * round-trip cleanly.
 *
 * Hunk-count fix-up (PR #222 t10): every dropped `+` line decrements the hunk's new-side count.
 * Without this, the stored PATCH.diff becomes unparseable — `git apply` (and `--3way`) parse @@
 * headers strictly and reject any mismatch between declared added-line count and actual body.
 */
export function stripApplyMarkersFromPatchFiles(args: { patch: string }): string {
    // Apply-time opener: added line matches `#region @stash:NAME {...json...}`. The JSON brace is
    // what distinguishes it from a bare author marker, which has no metadata and must be kept.
    const APPLY_OPEN_WITH_NAME = /^\+.*#region\s+@stash:([\w.-]+)\s+\{.*\}/;
    // Any added closer — used only to drop closers whose paired opener was an apply-time opener.
    const CLOSE_WITH_NAME = /^\+.*#endregion\s+@stash:([\w.-]+)/;
    // Unified-diff hunk header: `@@ -oldStart,oldLines +newStart,newLines @@ <optional ctx>`.
    const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

    const lines = args.patch.split("\n");
    // PR #222 t27: per-name apply depth counter, not a Set. Two nested apply-time openers with the
    // same stash name would otherwise share one Set entry — deleting on the first close would leave
    // the second close unmatched in the output.
    const applyCloseDepth = new Map<string, number>();
    // PR #222 t33: track bare author regions separately so an inner `#endregion @stash:NAME` is not
    // dropped while an outer apply-time wrapper of the same name is still open.
    const authorCloseDepth = new Map<string, number>();
    // Buffer per hunk so we can rewrite the header after counting dropped `+` lines.
    let currentHeader: { oldStart: number; oldLines: number; newStart: number; newLines: number; ctx: string } | null =
        null;
    let currentBody: string[] = [];
    let droppedInHunk = 0;
    const out: string[] = [];

    const flushHunk = () => {
        if (!currentHeader) {
            return;
        }
        const newLinesAdjusted = currentHeader.newLines - droppedInHunk;
        // Emit corrected header. If `,N` was originally absent (single-line hunk), still write it
        // when the adjusted value is no longer 1 — that's the only safe normalization.
        const oldPart = `${currentHeader.oldStart},${currentHeader.oldLines}`;
        const newPart = `${currentHeader.newStart},${newLinesAdjusted}`;
        out.push(`@@ -${oldPart} +${newPart} @@${currentHeader.ctx}`);
        out.push(...currentBody);
        currentHeader = null;
        currentBody = [];
        droppedInHunk = 0;
    };

    for (const line of lines) {
        const hm = HUNK_RE.exec(line);
        if (hm) {
            flushHunk();
            currentHeader = {
                oldStart: Number(hm[1]),
                oldLines: Number(hm[2] ?? "1"),
                newStart: Number(hm[3]),
                newLines: Number(hm[4] ?? "1"),
                ctx: hm[5] ?? "",
            };
            continue;
        }
        // File-level headers, index headers, etc. — flush any open hunk and pass through.
        if (!currentHeader) {
            out.push(line);
            continue;
        }
        const openMatch = APPLY_OPEN_WITH_NAME.exec(line);
        if (openMatch?.[1]) {
            const name = openMatch[1];
            applyCloseDepth.set(name, (applyCloseDepth.get(name) ?? 0) + 1);
            droppedInHunk++;
            continue;
        }
        const bareOpenMatch = /^\+.*#region\s+@stash:([\w.-]+)/.exec(line);
        if (bareOpenMatch?.[1] && !APPLY_OPEN_WITH_NAME.test(line)) {
            const name = bareOpenMatch[1];
            authorCloseDepth.set(name, (authorCloseDepth.get(name) ?? 0) + 1);
            currentBody.push(line);
            continue;
        }
        const closeMatch = CLOSE_WITH_NAME.exec(line);
        if (closeMatch?.[1]) {
            const name = closeMatch[1];
            const authorDepth = authorCloseDepth.get(name) ?? 0;
            if (authorDepth > 0) {
                if (authorDepth === 1) {
                    authorCloseDepth.delete(name);
                } else {
                    authorCloseDepth.set(name, authorDepth - 1);
                }
                currentBody.push(line);
                continue;
            }
            const applyDepth = applyCloseDepth.get(name) ?? 0;
            if (applyDepth > 0) {
                if (applyDepth === 1) {
                    applyCloseDepth.delete(name);
                } else {
                    applyCloseDepth.set(name, applyDepth - 1);
                }
                droppedInHunk++;
                continue;
            }
        }
        currentBody.push(line);
    }
    flushHunk();
    return out.join("\n");
}