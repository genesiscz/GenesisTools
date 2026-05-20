import { formatBytes } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import {
    CLONES_GLOSSARY,
    type CloneRenderer,
    type DirNode,
    type DuplicatesReport,
    type MeasureReport,
    type ProcessListReport,
    type ProcessOp,
    type ProcessReport,
} from "./types";

function realCell(real: number | null): string {
    return real === null ? "unavailable" : formatBytes(real);
}

function overcountCell(oc: number | null): string {
    return oc === null ? "—" : `${oc.toFixed(1)}×`;
}

function flattenTree(nodes: DirNode[], out: DirNode[] = []): DirNode[] {
    for (const n of nodes) {
        out.push(n);
        flattenTree(n.children, out);
    }

    return out;
}

export class TableRenderer implements CloneRenderer {
    measure(r: MeasureReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones measure — ${r.roots.join(", ")}`));
        if (r.nodeModulesMode) {
            lines.push(pc.dim("node_modules focus mode"));
        }

        const rows: string[][] = [];
        for (const n of flattenTree(r.tree)) {
            const indent = "  ".repeat(n.depth);
            const label = `${indent}${n.path.split("/").pop() ?? n.path}`;
            rows.push([
                label,
                formatBytes(n.logical),
                formatBytes(n.allocated),
                realCell(n.real),
                overcountCell(n.overcount),
            ]);
            if (n.sharedNote) {
                rows.push([`${indent}  └ ${n.sharedNote}`, "", "", "", ""]);
            }
        }

        if (rows.length > 0) {
            // Path column needs room for nested indent + sharedNote text
            // ("X.X MB shared with cross-tree partner ..."), so 100 instead of 60.
            lines.push(
                formatTable(rows, ["path", "logical", "du -sh", "real", "overcount"], {
                    alignRight: [1, 2, 3, 4],
                    maxColWidth: 100,
                }),
            );
        }

        lines.push("");
        lines.push(
            pc.bold(
                `TOTAL  logical ${formatBytes(r.totals.logical)}  du ${formatBytes(r.totals.allocated)}  ` +
                    `real ${realCell(r.totals.real)}  overcount ${overcountCell(r.totals.overcount)}`
            )
        );
        lines.push(
            pc.dim(`free space: ${formatBytes(r.freeSpace.available)} available of ${formatBytes(r.freeSpace.total)}`)
        );

        if (r.cloneAnalysis.families > 0) {
            lines.push("");
            lines.push(pc.bold("clone analysis"));
            const sharedSuffix =
                r.cloneAnalysis.sharedBytes > 0
                    ? `, ${formatBytes(r.cloneAnalysis.sharedBytes)} shared cross-tree (stays on disk if deleted)`
                    : " (all family members are in-scope — fully reclaimable)";
            lines.push(
                `  ${r.cloneAnalysis.families} family(ies), ${r.cloneAnalysis.clonedFiles} cloned file(s)${sharedSuffix}`,
            );
            if (r.cloneAnalysis.crossTreePartners.length > 0) {
                lines.push(`  cross-tree partners: ${r.cloneAnalysis.crossTreePartners.join(", ")}`);
            }

            for (const note of r.cloneAnalysis.notes) {
                lines.push(`  ${note}`);
            }
        }

        if (r.errors.length > 0) {
            lines.push(pc.yellow(`(${r.errors.length} path(s) skipped: ${r.errors[0].errno}…)`));
        }

        lines.push("");
        lines.push(pc.dim(CLONES_GLOSSARY));
        return lines.join("\n");
    }

    duplicates(r: DuplicatesReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones duplicates — ${r.roots.join(", ")}`));
        if (r.sets.length === 0) {
            lines.push(pc.dim("No non-clone duplicates found."));
        } else {
            const rows = r.sets.map((s) => [
                s.kind,
                s.what,
                String(s.copies),
                formatBytes(s.eachBytes),
                formatBytes(s.reclaimable),
            ]);
            lines.push(
                formatTable(rows, ["kind", "what", "copies", "each", "reclaimable"], {
                    alignRight: [2, 3, 4],
                    maxColWidth: 60,
                })
            );

            if (r.grouped) {
                lines.push("");
                for (const s of r.sets) {
                    lines.push(pc.bold(s.what));
                    for (const m of s.members) {
                        const tag = m === s.keep ? pc.green(" (keep)") : "";
                        lines.push(`  ${m}${tag}`);
                    }
                }
            }
        }

        lines.push("");
        lines.push(pc.bold(`projected reclaim: ${formatBytes(r.totalReclaimable)}`));
        lines.push("");
        lines.push(pc.dim(CLONES_GLOSSARY));
        return lines.join("\n");
    }

    processReport(r: ProcessReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones optimize [${r.state}] — process ${r.id}`));
        lines.push(
            pc.dim(
                `roots: ${r.roots.join(", ")}  plan cache: ` +
                    `${r.planCache.hit ? `hit (${Math.round((r.planCache.ageMs ?? 0) / 1000)}s old)` : "miss"}`
            )
        );

        const opRows = r.ops.map((op: ProcessOp) => [
            String(op.seq),
            op.op,
            op.status,
            op.bytes > 0 ? formatBytes(op.bytes) : "",
            op.replace,
        ]);
        if (opRows.length > 0) {
            lines.push(
                formatTable(opRows, ["#", "op", "status", "bytes", "replace"], {
                    alignRight: [3],
                    maxColWidth: 60,
                })
            );
        }

        const skipped = r.ops.filter((o) => o.op === "skip");
        if (skipped.length > 0) {
            lines.push("");
            lines.push(pc.bold("Skipped:"));
            for (const o of skipped) {
                lines.push(`  ${o.replace} — ${o.status}${o.message ? ` (${o.message})` : ""}`);
            }
        }

        const errored = r.ops.filter((o) => o.op === "error");
        if (errored.length > 0) {
            lines.push("");
            lines.push(pc.red("Errors:"));
            for (const o of errored) {
                lines.push(`  ${o.replace} — ${o.status}${o.message ? ` (${o.message})` : ""}`);
            }
        }

        lines.push("");
        const rollbackOps = r.ops.filter((o) => o.op === "rollback-uncloned");
        if (r.state === "rolled-back") {
            const undone = rollbackOps.length;
            const reUnshared = rollbackOps.reduce((s, o) => s + o.bytes, 0);
            lines.push(
                pc.bold(
                    `TOTAL  un-shared ${undone}  re-allocated ${formatBytes(reUnshared)}  ` +
                        `(original apply: cloned ${r.totals.cloned}, reclaimed ${formatBytes(r.totals.bytesReclaimed)})`,
                ),
            );
            // Shell-quote each root so the suggested command is copy-pasteable
            // even when paths contain spaces, quotes, or shell metachars.
            const quotedRoots = r.roots.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
            lines.push(pc.dim(`tools macos clones optimize --apply --yes ${quotedRoots}`));
        } else {
            lines.push(
                pc.bold(
                    `TOTAL  cloned ${r.totals.cloned}  skipped ${r.totals.skipped}  ` +
                        `errors ${r.totals.errors}  reclaimed ${formatBytes(r.totals.bytesReclaimed)}`,
                ),
            );
            if (r.state === "applied") {
                lines.push(pc.dim(`tools macos clones optimize --rollback --process ${r.id}`));
            }
        }

        return lines.join("\n");
    }

    processList(r: ProcessListReport): string {
        if (r.processes.length === 0) {
            return pc.dim("No optimize runs recorded.");
        }

        const rows = r.processes.map((p) => [
            p.id,
            p.state,
            p.roots.join(","),
            String(p.totals.cloned),
            formatBytes(p.totals.bytesReclaimed),
            p.startedAt,
        ]);
        return formatTable(rows, ["id", "state", "roots", "cloned", "reclaimed", "startedAt"], {
            maxColWidth: 50,
        });
    }
}
