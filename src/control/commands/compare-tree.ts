import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { numberFlag } from "../lib/flag-number";
import { readSnapshotGeometry } from "../lib/snapshot-geometry";
import { diffViewTrees, readViewTree, treeDiffAnnotations, treeSidecarPath } from "../lib/view-tree-diff";

export function registerCompareTreeCommand(program: Command): void {
    program
        .command("compare-tree <before> <after>")
        .description(
            "Diff the view trees of two GenesisTools hub --snapshot shots taken with --snapshot-tree (<shot>.tree.json beside each PNG): controls matched by identifier, else role path, reported as moved, resized, added, removed or restyled. Text values are never compared; other row counts, text widths and what a wider text pushed along are data-only.\nExit 0 = no layout change, 1 = changes, 2 = no usable tree (missing, without nodes, or cut at its limit)."
        )
        .option("--tolerance <pt>", "frame differences up to this many points are equal", "1")
        .option("--json", "machine-readable result JSON on stdout, with draw plans for both sides in image pixels")
        .action(async (beforePath: string, afterPath: string, opts: { tolerance: string; json?: boolean }) => {
            const tolerance = numberFlag(opts.tolerance, "--tolerance");

            const [before, after] = await Promise.all([readViewTree(beforePath), readViewTree(afterPath)]);
            for (const [path, tree] of [
                [beforePath, before],
                [afterPath, after],
            ] as const) {
                if (!tree) {
                    logger.error(`no view tree at ${treeSidecarPath(path)}: take the hub shot with --snapshot-tree`);
                    process.exit(2);
                }

                if (tree.source === "none") {
                    logger.error(
                        `${treeSidecarPath(path)} holds no nodes: the snapshot ran without the Accessibility grant`
                    );
                    process.exit(2);
                }

                if (tree.truncated) {
                    logger.error(
                        `${treeSidecarPath(path)} was cut at its node or depth limit: a change in the left-out part would not show`
                    );
                    process.exit(2);
                }
            }

            if (!before || !after) {
                process.exit(2);
            }

            const diff = diffViewTrees(before, after, { tolerance });
            const png = (path: string) => path.replace(/\.tree\.json$/, ".png");
            const [geometryBefore, geometryAfter] = await Promise.all([
                readSnapshotGeometry(png(beforePath)),
                readSnapshotGeometry(png(afterPath)),
            ]);
            const scale = { before: geometryBefore?.scale ?? 1, after: geometryAfter?.scale ?? 1 };
            logger.debug(
                { before: beforePath, after: afterPath, changes: diff.changes.length, dataOnly: diff.dataOnly.length },
                "compare-tree"
            );

            if (opts.json) {
                out.result({
                    ok: diff.changes.length === 0,
                    ...diff,
                    scale,
                    draw: treeDiffAnnotations(diff, { scale }),
                });
            } else {
                out.println(
                    `${diff.matched} matched, ${diff.changes.length} change(s), ${diff.dataOnly.length} data-only difference(s)`
                );
                for (const change of diff.changes) {
                    const frames = [change.before, change.after]
                        .map((rect) => (rect ? `${rect.x},${rect.y} ${rect.w}x${rect.h}` : "-"))
                        .join(" -> ");
                    const fields = change.fields ? ` (${change.fields.join(", ")})` : "";
                    out.println(`  ${pc.red(change.kind.padEnd(9))} ${change.key}${fields}  ${pc.dim(frames)}`);
                }

                for (const entry of diff.dataOnly) {
                    out.println(
                        `  ${pc.yellow("data".padEnd(9))} ${entry.key}  ${pc.dim(entry.detail ?? entry.reason)}`
                    );
                }
            }

            process.exit(diff.changes.length === 0 ? 0 : 1);
        });
}
