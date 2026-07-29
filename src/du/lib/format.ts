import pc from "picocolors";
import type { ClonesizeResult, Engine, NodeResult, PartnersResult, VolumeInfo } from "./types";

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

/**
 * Decimal (SI) bytes. `diskutil` and the Finder both report base-10, so the
 * volume reconcile has to as well — quoting 885 GiB next to diskutil's 950 GB
 * looks like a 65 GB discrepancy that does not exist.
 */
export function humanBytesDecimal(b: number): string {
    const KB = 1000,
        MB = KB * 1000,
        GB = MB * 1000,
        TB = GB * 1000;
    if (b >= TB) {
        return `${(b / TB).toFixed(2)} TB`;
    }
    if (b >= GB) {
        return `${(b / GB).toFixed(1)} GB`;
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

/**
 * Warn about subtrees the scan could not read, and hand back the exact command
 * that would close the gap. A silent skip here is how a 132 GB hole hid inside a
 * "complete" home scan.
 */
export function renderDenied(r: { denied_dirs?: number; denied_files?: number; denied_paths?: string[] }): string[] {
    const dirs = r.denied_dirs ?? 0;
    const files = r.denied_files ?? 0;
    if (dirs === 0 && files === 0) {
        return [];
    }

    const L: string[] = [""];
    const what = [dirs > 0 ? `${dirs} director${dirs === 1 ? "y" : "ies"}` : "", files > 0 ? `${files} file(s)` : ""]
        .filter(Boolean)
        .join(" and ");
    L.push(pc.yellow(`  ⚠ ${what} could not be read — every total above is INCOMPLETE.`));

    const paths = r.denied_paths ?? [];
    for (const p of paths.slice(0, 10)) {
        L.push(pc.dim(`     ${p}`));
    }
    if (paths.length > 10) {
        L.push(pc.dim(`     ... and ${paths.length - 10} more`));
    }
    if (dirs + files > paths.length) {
        L.push(pc.dim(`     (${dirs + files - paths.length} further denial(s) not listed)`));
    }
    if (paths.length > 0) {
        L.push("");
        L.push(pc.dim("  Re-run as root to resolve them:"));
        L.push(`     sudo tools du clonesize ${shellQuote(paths[0]!)}`);
    }
    return L;
}

/** Quote a path for copy-paste into a shell. */
function shellQuote(p: string): string {
    return /^[\w./@:-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
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

    // Freeable leads. It is the only line that answers the question people
    // actually ask ("what do I get back if I delete this"), and reading top-down
    // past "Real unique on disk" is how a free clone gets mistaken for a full copy.
    if (r.private_sum_bytes !== undefined) {
        L.push(
            `  ${pad("Deleting this frees \u2265", 26)} ${pc.bold(
                pc.cyan(padStart(humanBytes(r.private_sum_bytes), 12))
            )}  ${pc.dim("(blocks nothing else on the volume references)")}`
        );
    }
    L.push(
        `  ${pad("Real unique on disk", 26)} ${padStart(
            humanBytes(r.unique_allocated_bytes ?? r.unique_bytes),
            12
        )}  ${pc.dim("(deduped WITHIN this scan only)")}`
    );
    if (r.unique_allocated_bytes !== undefined && r.unique_allocated_bytes !== r.unique_bytes) {
        L.push(
            `  ${pad("  ... mapped bytes only", 26)} ${padStart(humanBytes(r.unique_bytes), 12)}  ${pc.dim(
                "(excludes per-file block slack)"
            )}`
        );
    }
    L.push(`  ${pad("Naive (what du reports)", 26)} ${padStart(humanBytes(r.naive_bytes), 12)}`);
    L.push(
        `  ${pad("Shared via CoW clones", 26)} ${pc.green(padStart(humanBytes(r.shared_bytes), 12))}  ${pc.dim(
            `(${savedPct}% of naive collapses)`
        )}`
    );
    if (r.cross_group_shared_bytes > 0) {
        L.push(`  ${pad("Shared across marked dirs", 26)} ${padStart(humanBytes(r.cross_group_shared_bytes), 12)}`);
    }
    if (r.outside_shared_bytes !== undefined && r.outside_shared_bytes > 0) {
        L.push(
            `  ${pad("Shared OUTSIDE this scan", 26)} ${pc.yellow(
                padStart(humanBytes(r.outside_shared_bytes), 12)
            )}  ${pc.dim("(also referenced by files above/outside the root)")}`
        );
    }
    if (r.sparse_files !== undefined && r.sparse_files > 0) {
        L.push(
            `  ${pad("Sparse (never written)", 26)} ${padStart(humanBytes(r.sparse_bytes ?? 0), 12)}  ${pc.dim(
                `(${r.sparse_files.toLocaleString()} sparse file(s); apparent ${humanBytes(r.apparent_bytes ?? 0)})`
            )}`
        );
    }

    // The scope-limited-uniqueness trap: scanning ONE side of a clone pair shows
    // "unique == naive, 0% shared", which reads as "this cost me full size".
    if (r.outside_shared_bytes !== undefined && r.outside_shared_bytes > 0) {
        L.push("");
        L.push(
            pc.yellow(
                `  \u26a0 ${humanBytes(r.outside_shared_bytes)} of this tree's blocks are ALSO referenced outside the scan root.`
            )
        );
        L.push(pc.dim(`     "Real unique on disk" counts them; deleting this tree would not free them.`));
        L.push(pc.dim("     Scan the parent directory to see the true sharing."));
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

    L.push(...renderDenied(r));

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
    if (r.changed_since !== undefined) {
        meta.push(`changed since ${new Date(r.changed_since * 1000).toISOString().slice(0, 16).replace("T", " ")}`);
    }
    L.push(pc.dim(meta.join("  •  ")));
    L.push(
        pc.dim(
            `  ${pad("dir", 40)}${padStart("naive", 11)}${padStart("unique", 11)}${padStart(
                "x-shared",
                11
            )}${padStart("frees ≥", 11)}`
        )
    );

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
    const sparse = (n: NodeResult): boolean => (n.sparse_files ?? 0) > 0;
    const emit = (idx: number, indent: number) => {
        const n = nodes[idx]!;
        const base = indent === 0 ? n.path : n.path.slice(n.path.lastIndexOf("/") + 1);
        const name = `${"  ".repeat(indent)}${n.clone_flagged ? pc.yellow(base) : base}${
            sparse(n) ? ` ${pc.magenta("sparse")}` : ""
        }`;
        const namePlain = `${"  ".repeat(indent)}${sparse(n) ? `${base} sparse` : base}`;
        L.push(
            `  ${pad(name + " ".repeat(Math.max(0, 40 - namePlain.length)), 40 + (name.length - namePlain.length))}` +
                `${padStart(humanBytes(n.naive_bytes), 11)}` +
                `${padStart(humanBytes(n.unique_allocated_bytes ?? n.unique_bytes), 11)}` +
                `${padStart(n.cross_shared_bytes > 0 ? humanBytes(n.cross_shared_bytes) : "-", 11)}` +
                `${padStart(n.freeable_floor_bytes !== undefined ? humanBytes(n.freeable_floor_bytes) : "-", 11)}`
        );
        const kids = (byParent.get(idx) ?? [])
            .slice()
            .sort(
                (a, b) =>
                    (nodes[b]!.unique_allocated_bytes ?? nodes[b]!.unique_bytes) -
                    (nodes[a]!.unique_allocated_bytes ?? nodes[a]!.unique_bytes)
            );
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
            `  unique = clone-deduped allocated bytes within the subtree · x-shared = bytes shared with dirs OUTSIDE it`
        )
    );
    L.push(
        pc.dim(
            `  frees ≥ = Σ per-file blocks private volume-wide (a floor: a dir cloned entirely within itself reads 0)`
        )
    );
    if (nodes.some(sparse)) {
        L.push(pc.dim(`  ${pc.magenta("sparse")} = holds sparse files; apparent size far exceeds allocated blocks`));
    }
    L.push(...renderDenied(r));
    return L.join("\n");
}

/**
 * Volume reconcile (`tools du volume`). The whole point is the last line: what
 * the volume says it spent, minus what the scan could see, equals the hole.
 */
export function renderVolume(vol: VolumeInfo, scan: ClonesizeResult, elapsedMs?: number): string {
    const L: string[] = [];
    const scanned = scan.unique_allocated_bytes ?? scan.unique_bytes;
    const unaccounted = vol.used_bytes - scanned;

    L.push(pc.bold(`Volume reconcile — ${vol.mount}`));
    const meta = [`${scan.files_scanned.toLocaleString()} files`, `${scan.threads} threads`];
    if (elapsedMs !== undefined) {
        meta.push(`${(elapsedMs / 1000).toFixed(1)}s`);
    }
    L.push(pc.dim(meta.join("  •  ")));
    L.push("");
    L.push(`  ${pad("Volume size", 26)} ${padStart(humanBytesDecimal(vol.size_bytes), 12)}`);
    L.push(
        `  ${pad("Volume used (APFS)", 26)} ${pc.bold(padStart(humanBytesDecimal(vol.used_bytes), 12))}  ${pc.dim(
            "= diskutil 'Volume Used Space'"
        )}`
    );
    L.push(`  ${pad("Volume free", 26)} ${padStart(humanBytesDecimal(vol.free_bytes), 12)}`);
    L.push(`  ${pad("Scanned unique (alloc)", 26)} ${padStart(humanBytesDecimal(scanned), 12)}`);

    const pct = vol.used_bytes > 0 ? (Math.abs(unaccounted) / vol.used_bytes) * 100 : 0;
    const deltaLabel = unaccounted >= 0 ? "UNACCOUNTED" : "over-counted";
    const deltaText = `${padStart(humanBytesDecimal(Math.abs(unaccounted)), 12)}  ${pc.dim(`(${pct.toFixed(1)}% of used)`)}`;
    L.push(`  ${pad(deltaLabel, 26)} ${pct >= 1 ? pc.yellow(deltaText) : pc.green(deltaText)}`);

    const cloud = scan.skipped_cloud ?? [];
    if (cloud.length > 0) {
        L.push("");
        L.push(pc.yellow(`  ⚠ ${cloud.length} cloud-provider root(s) were NOT walked:`));
        for (const c of cloud) {
            L.push(pc.dim(`     ${c}`));
        }
        L.push(pc.dim("  Their contents are mostly placeholders that live on someone else's disk, and reading"));
        L.push(pc.dim("  one can download it. Pass --include-cloud to walk them anyway."));
    }

    const mounts = scan.skipped_mounts ?? [];
    if (mounts.length > 0) {
        L.push("");
        L.push(pc.dim(`  ${mounts.length} mount point(s) of other filesystems were skipped — their bytes belong to`));
        L.push(pc.dim("  another volume, and walking an autofs or network mount can hang the scan:"));
        for (const m of mounts.slice(0, 8)) {
            L.push(pc.dim(`     ${m}`));
        }
        if (mounts.length > 8) {
            L.push(pc.dim(`     ... and ${mounts.length - 8} more`));
        }
    }

    // Denials are reported whenever they happened, never gated on the sign of the
    // gap. A volume can over-count (clones counted on both sides, purgeable churn)
    // and still have hundreds of unreadable paths; gating on `unaccounted > 0` hid
    // them in exactly that case, which is the silence this report exists to break.
    // Only the "prime suspect for the gap" framing depends on there being a gap.
    const denied = (scan.denied_dirs ?? 0) + (scan.denied_files ?? 0);
    if (denied > 0) {
        L.push("");
        L.push(
            unaccounted > 0
                ? pc.yellow(`  ⚠ ${denied} unreadable path(s) — the prime suspect for the gap.`)
                : pc.yellow(`  ⚠ ${denied} unreadable path(s) — every total above is INCOMPLETE.`)
        );
        for (const p of (scan.denied_paths ?? []).slice(0, 10)) {
            L.push(pc.dim(`     ${p}`));
        }
        L.push("");
        L.push(pc.dim("  Resolve it with:"));
        L.push(`     sudo tools du volume ${shellQuote(vol.mount)}`);
    } else if (unaccounted > 0) {
        L.push("");
        L.push(
            pc.dim(
                "  No denials, so the gap is volume metadata, snapshots, or purgeable space —" +
                    " none of which a directory walk can see."
            )
        );
    }
    return L.join("\n");
}

/** `tools du clones <dir>`: the concrete paths holding the target's blocks. */
export function renderPartners(p: PartnersResult, elapsedMs?: number): string {
    const L: string[] = [];
    L.push(pc.bold(`Clone partners of ${p.target}`));
    const meta = [`searched ${p.root}`, `${p.files_opened.toLocaleString()} shared files opened`];
    if (elapsedMs !== undefined) {
        meta.push(`${(elapsedMs / 1000).toFixed(1)}s`);
    }
    L.push(pc.dim(meta.join("  •  ")));
    L.push("");
    L.push(`  ${pad("Target blocks shared", 26)} ${padStart(humanBytes(p.target_shared_bytes), 12)}`);
    L.push(
        `  ${pad("Held by other files", 26)} ${padStart(p.partner_files_total.toLocaleString(), 12)}  ${pc.dim(
            `(${humanBytes(p.partner_bytes)} counted per partner)`
        )}`
    );

    if (p.partner_dirs.length === 0) {
        L.push("");
        L.push(
            pc.dim(`  No partners under ${p.root} — the shared blocks live outside it, or the target shares nothing.`)
        );
        return [...L, ...renderDenied(p)].join("\n");
    }

    L.push("");
    L.push(pc.bold("  Partner directories:"));
    L.push(pc.dim(`  ${pad("dir", 60)}${padStart("shared", 11)}${padStart("files", 8)}`));
    for (const d of p.partner_dirs) {
        L.push(
            `  ${pad(d.path.length > 59 ? `…${d.path.slice(-58)}` : d.path, 60)}${padStart(humanBytes(d.shared_bytes), 11)}${padStart(String(d.files ?? 0), 8)}`
        );
    }

    L.push("");
    L.push(pc.bold("  Partner files:"));
    for (const f of p.partner_files) {
        L.push(
            `  ${pad(f.path.length > 67 ? `…${f.path.slice(-66)}` : f.path, 68)}${padStart(humanBytes(f.shared_bytes), 11)}`
        );
    }

    L.push("");
    L.push(
        pc.dim(
            "  These paths hold the SAME physical blocks. Deleting the target frees nothing that a partner still references."
        )
    );
    return L.join("\n");
}

export interface DiffRow {
    path: string;
    before: number;
    after: number;
    delta: number;
    status: "grown" | "shrunk" | "new" | "gone";
}

/** Per-directory delta between two saved scans of the same tree. */
export function diffScans(before: ClonesizeResult, after: ClonesizeResult): DiffRow[] {
    const key = (n: NodeResult): number => n.unique_allocated_bytes ?? n.unique_bytes;
    const prev = new Map<string, number>((before.nodes ?? []).map((n) => [n.path, key(n)]));
    const next = new Map<string, number>((after.nodes ?? []).map((n) => [n.path, key(n)]));

    const rows: DiffRow[] = [];
    for (const [path, afterBytes] of next) {
        const beforeBytes = prev.get(path);
        if (beforeBytes === undefined) {
            rows.push({ path, before: 0, after: afterBytes, delta: afterBytes, status: "new" });
        } else if (beforeBytes !== afterBytes) {
            rows.push({
                path,
                before: beforeBytes,
                after: afterBytes,
                delta: afterBytes - beforeBytes,
                status: afterBytes > beforeBytes ? "grown" : "shrunk",
            });
        }
    }
    for (const [path, beforeBytes] of prev) {
        if (!next.has(path)) {
            rows.push({ path, before: beforeBytes, after: 0, delta: -beforeBytes, status: "gone" });
        }
    }

    return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function renderDiff(before: ClonesizeResult, after: ClonesizeResult, rows: DiffRow[]): string {
    const L: string[] = [];
    L.push(pc.bold(`Scan diff — ${after.path}`));
    const beforeTotal = before.unique_allocated_bytes ?? before.unique_bytes;
    const afterTotal = after.unique_allocated_bytes ?? after.unique_bytes;
    const delta = afterTotal - beforeTotal;
    L.push(
        pc.dim(
            `${humanBytes(beforeTotal)} → ${humanBytes(afterTotal)}  •  ${
                delta >= 0 ? "+" : "−"
            }${humanBytes(Math.abs(delta))} total`
        )
    );

    if (rows.length === 0) {
        L.push("");
        L.push(pc.green("  No per-directory change."));
        return L.join("\n");
    }

    L.push("");
    L.push(pc.dim(`  ${pad("dir", 52)}${padStart("before", 11)}${padStart("after", 11)}${padStart("delta", 12)}`));
    for (const r of rows) {
        const sign = r.delta >= 0 ? "+" : "−";
        const deltaText = `${sign}${humanBytes(Math.abs(r.delta))}`;
        const colored = r.delta >= 0 ? pc.red(deltaText) : pc.green(deltaText);
        const tag = r.status === "new" ? " (new)" : r.status === "gone" ? " (gone)" : "";
        const room = 51 - tag.length;
        const label = `${r.path.length > room ? `…${r.path.slice(-(room - 1))}` : r.path}${tag}`;
        L.push(
            `  ${pad(label, 52)}` +
                `${padStart(humanBytes(r.before), 11)}${padStart(humanBytes(r.after), 11)}${padStart(colored, 12 + (colored.length - deltaText.length))}`
        );
    }
    return L.join("\n");
}
