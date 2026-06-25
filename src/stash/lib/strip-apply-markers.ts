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
    // PR #222 t36: LIFO stack per name pairs each `#endregion` with the most recent same-name opener.
    // Separate counters mishandle inverse nesting (author wrapper containing apply wrapper).
    type CloseKind = "apply" | "author";
    const closeStackByName = new Map<string, CloseKind[]>();
    const pushCloseKind = (name: string, kind: CloseKind) => {
        const stack = closeStackByName.get(name) ?? [];
        stack.push(kind);
        closeStackByName.set(name, stack);
    };
    const popCloseKind = (name: string): CloseKind | null => {
        const stack = closeStackByName.get(name);
        if (!stack) {
            return null;
        }
        const kind = stack.pop();
        if (stack.length === 0) {
            closeStackByName.delete(name);
        }
        return kind ?? null;
    };
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
            pushCloseKind(name, "apply");
            droppedInHunk++;
            continue;
        }
        const bareOpenMatch = /^\+.*#region\s+@stash:([\w.-]+)/.exec(line);
        if (bareOpenMatch?.[1] && !APPLY_OPEN_WITH_NAME.test(line)) {
            const name = bareOpenMatch[1];
            pushCloseKind(name, "author");
            currentBody.push(line);
            continue;
        }
        const closeMatch = CLOSE_WITH_NAME.exec(line);
        if (closeMatch?.[1]) {
            const name = closeMatch[1];
            const closeKind = popCloseKind(name);
            if (closeKind === "author") {
                currentBody.push(line);
                continue;
            }
            if (closeKind === "apply") {
                droppedInHunk++;
                continue;
            }
        }
        currentBody.push(line);
    }
    flushHunk();
    return out.join("\n");
}
