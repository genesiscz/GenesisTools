import pc from "picocolors";
import type { ClonesizeResult, Engine } from "./types";

export function humanBytes(b: number): string {
    const KB = 1024,
        MB = KB * 1024,
        GB = MB * 1024,
        TB = GB * 1024;
    if (b >= TB) {
        return `${(b / TB).toFixed(2)} TB`;
    }
    if (b >= GB) {
        return `${(b / GB).toFixed(2)} GB`;
    }
    if (b >= MB) {
        return `${(b / MB).toFixed(1)} MB`;
    }
    if (b >= KB) {
        return `${(b / KB).toFixed(1)} KB`;
    }
    return `${b} B`;
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
    return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/** Pretty, human-first rendering of a scan result. */
export function renderHuman(r: ClonesizeResult, engine: Engine, elapsedMs?: number): string {
    const L: string[] = [];
    const savedPct = r.shared_pct.toFixed(1);

    L.push(pc.bold(`Clone-aware disk usage — ${r.path}`));
    const meta: string[] = [`${r.files_scanned.toLocaleString()} files`, `${engine} engine`, `${r.threads} threads`];
    if (elapsedMs !== undefined) {
        meta.push(`${(elapsedMs / 1000).toFixed(2)}s`);
    }
    L.push(pc.dim(meta.join("  •  ")));
    L.push("");

    L.push(`  ${pad("Naive (what du reports)", 26)} ${padStart(humanBytes(r.naive_bytes), 12)}`);
    L.push(`  ${pad("Real unique on disk", 26)} ${pc.bold(padStart(humanBytes(r.unique_bytes), 12))}`);
    L.push(
        `  ${pad("Shared via CoW clones", 26)} ${pc.green(padStart(humanBytes(r.shared_bytes), 12))}  ${pc.dim(
            `(${savedPct}% of naive collapses)`
        )}`
    );
    if (r.cross_group_shared_bytes > 0) {
        L.push(`  ${pad("Shared across marked dirs", 26)} ${padStart(humanBytes(r.cross_group_shared_bytes), 12)}`);
    }
    if (r.private_sum_bytes !== undefined) {
        L.push(
            `  ${pad("Σ per-file private", 26)} ${padStart(humanBytes(r.private_sum_bytes), 12)}  ${pc.dim(
                "(exclusive to one file volume-wide)"
            )}`
        );
    }

    // Marked-dir table (only the interesting rows: sizeable + any clone-flagged).
    const groups = r.groups.filter((g) => g.naive_bytes > 0).sort((a, b) => b.naive_bytes - a.naive_bytes);
    const shown = groups.filter((g, i) => i < 15 || g.clone_flagged);

    if (shown.length > 0) {
        L.push("");
        L.push(pc.bold("  Marked directories (immediate children):"));
        L.push(
            pc.dim(
                `  ${pad("dir", 34)}${padStart("naive", 11)}${padStart("files", 9)}${padStart(
                    "x-shared",
                    11
                )}${padStart("share%", 8)}  cluster`
            )
        );
        for (const g of shown) {
            const cluster =
                g.cross_group_shared_bytes > 0
                    ? `#${g.clone_cluster}${g.clone_flagged ? pc.yellow(" ★clone") : ""}`
                    : pc.dim("-");
            const name = g.clone_flagged ? pc.yellow(g.name) : g.name;
            L.push(
                `  ${pad(name + " ".repeat(Math.max(0, 34 - g.name.length)), 34 + (name.length - g.name.length))}` +
                    `${padStart(humanBytes(g.naive_bytes), 11)}${padStart(g.files.toLocaleString(), 9)}` +
                    `${padStart(humanBytes(g.cross_group_shared_bytes), 11)}${padStart(`${g.shared_pct.toFixed(1)}%`, 8)}  ${cluster}`
            );
        }
        const flagged = groups.filter((g) => g.clone_flagged).length;
        if (flagged > 0) {
            L.push("");
            L.push(pc.dim(`  ★clone = ≥30% of this dir's bytes are shared with another marked dir (largely a clone).`));
        }
    }

    return L.join("\n");
}

/**
 * Indented per-directory tree (`--depth N`). Children sorted by unique desc;
 * shows naive, unique (deduped within subtree), and x-shared (bytes shared with
 * dirs OUTSIDE this subtree).
 */
export function renderTree(r: ClonesizeResult, engine: Engine, elapsedMs?: number): string {
    const nodes = r.nodes ?? [];
    const L: string[] = [];

    L.push(pc.bold(`Clone-aware disk tree — ${r.path}`));
    const meta = [
        `${r.files_scanned.toLocaleString()} files`,
        `${engine} engine`,
        `depth ${r.depth}`,
        `${r.threads} threads`,
    ];
    if (elapsedMs !== undefined) {
        meta.push(`${(elapsedMs / 1000).toFixed(2)}s`);
    }
    L.push(pc.dim(meta.join("  •  ")));
    L.push(pc.dim(`  ${pad("dir", 40)}${padStart("naive", 11)}${padStart("unique", 11)}${padStart("x-shared", 11)}`));

    // Index children by parent for a depth-first, unique-desc walk.
    const byParent = new Map<number, number[]>();
    nodes.forEach((n, i) => {
        const arr = byParent.get(n.parent);
        if (arr) {
            arr.push(i);
        } else {
            byParent.set(n.parent, [i]);
        }
    });

    const rootIdx = nodes.findIndex((n) => n.parent < 0);
    const emit = (idx: number, indent: number) => {
        const n = nodes[idx]!;
        const label = indent === 0 ? n.path : n.path.slice(n.path.lastIndexOf("/") + 1);
        const name = `${"  ".repeat(indent)}${n.clone_flagged ? pc.yellow(label) : label}`;
        const namePlain = `${"  ".repeat(indent)}${label}`;
        L.push(
            `  ${pad(name + " ".repeat(Math.max(0, 40 - namePlain.length)), 40 + (name.length - namePlain.length))}` +
                `${padStart(humanBytes(n.naive_bytes), 11)}${padStart(humanBytes(n.unique_bytes), 11)}` +
                `${padStart(n.cross_shared_bytes > 0 ? humanBytes(n.cross_shared_bytes) : "-", 11)}`
        );
        const kids = (byParent.get(idx) ?? []).slice().sort((a, b) => nodes[b]!.unique_bytes - nodes[a]!.unique_bytes);
        for (const k of kids) {
            emit(k, indent + 1);
        }
    };
    if (rootIdx >= 0) {
        emit(rootIdx, 0);
    }

    L.push("");
    L.push(
        pc.dim(
            `  unique = clone-deduped bytes within the subtree · x-shared = bytes shared with dirs OUTSIDE it` +
                ` · deleting a dir frees ~ (unique − x-shared).`
        )
    );
    return L.join("\n");
}
