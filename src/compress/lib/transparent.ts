import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
// lint-rules-ignore: compress intentionally reuses du's native read-only metadata walker instead of implementing a second filesystem scan.
import { listCompressionFiles } from "@app/du/lib/engine";
import { type Mirror, openPaths, plan, type TransparentWriter } from "@genesiscz/utils/compress/transparent";
import { loadTransparentConfig } from "@genesiscz/utils/compress/transparent-config";
import { applyTransparent } from "@genesiscz/utils/compress/transparent-run";
import { parseDuration } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { getCloneId, getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

export interface TransparentOptions {
    root: string[];
    mirror: string[];
    preset?: string;
    older?: string;
    minKb?: string;
    ext?: string;
    algorithm?: string | boolean;
    onBattery?: boolean;
    json?: boolean;
}

function mirrorsOf(values: string[]): Mirror[] {
    return values.map((value) => {
        const separator = value.indexOf("=");
        if (separator < 1 || separator === value.length - 1) {
            throw new Error("--mirror requires <from>=<to>");
        }

        return { from: resolve(value.slice(0, separator)), to: resolve(value.slice(separator + 1)) };
    });
}

/** Query the existing clone metadata index read-only, and recheck clone IDs before trusting rows. */
function indexedPartners(ids: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const dbPath = genesisToolsDir("macos-clones", "cache", "file-meta.db");
    if (ids.length === 0 || !existsSync(dbPath)) {
        return result;
    }

    const db = new Database(dbPath, { readonly: true, create: false });
    try {
        if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='file_meta'").get()) {
            return result;
        }

        for (let at = 0; at < ids.length; at += 1000) {
            const chunk = ids.slice(at, at + 1000);
            const rows = db
                .query<{ path: string; clone_id: string }, string[]>(
                    `SELECT path,clone_id FROM file_meta WHERE clone_id IN (${chunk.map(() => "?").join(",")})`
                )
                .all(...chunk);
            for (const row of rows) {
                if (getCloneId(row.path)?.toString(16) !== row.clone_id) {
                    continue;
                }

                const members = result.get(row.clone_id) ?? [];
                members.push(row.path);
                result.set(row.clone_id, members);
            }
        }
    } finally {
        db.close();
    }

    return result;
}

export async function runTransparentPaths({
    paths,
    options,
    apply,
    writer,
}: {
    paths: string[];
    options: TransparentOptions;
    apply: boolean;
    writer: TransparentWriter;
}) {
    if (process.platform !== "darwin") {
        throw new Error("Transparent compression requires macOS/APFS");
    }

    const config = await loadTransparentConfig();
    if (options.preset !== undefined && options.preset !== "agents") {
        throw new Error("The transparent preset is agents");
    }

    const explicit = [...paths, ...options.root];
    const roots = [
        ...new Set(
            (explicit.length > 0 ? explicit : Object.values(config.harnesses).flatMap((harness) => harness.roots)).map(
                (root) => resolve(root)
            )
        ),
    ];
    const mirrors =
        options.mirror.length > 0
            ? mirrorsOf(options.mirror)
            : Object.values(config.harnesses).flatMap((harness) => harness.mirrors ?? []);
    const older = options.older ?? config.defaults.olderThan;
    const minKb = Number(options.minKb ?? config.defaults.minKb);
    if (!Number.isFinite(minKb) || minKb < 0) {
        throw new Error("--min-kb must be nonnegative");
    }

    const olderThanMs = parseDuration(older);
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
        throw new Error("--older requires a duration such as 3d");
    }

    const entries = [
        ...new Map(
            (await Promise.all(roots.map(listCompressionFiles))).flat().map((entry) => [entry.path, entry])
        ).values(),
    ];
    const first = plan(entries, {
        olderThanMs,
        minBytes: minKb * 1024,
        exts: new Set((options.ext?.split(",") ?? config.defaults.exts).map((ext) => ext.trim().toLowerCase())),
        open: new Set(),
        now: Date.now(),
        maxBytes: writer.maxBytes,
    });
    const held = first.candidates.length > 0 ? await openPaths() : new Set<string>();
    const candidates = first.candidates.filter((candidate) => !held.has(candidate.path));
    first.skips.open += first.candidates.length - candidates.length;
    const partners = indexedPartners([
        ...new Set(candidates.map((candidate) => candidate.cloneId ?? "").filter(Boolean)),
    ]);
    const live = new Map<string, string[]>();
    for (const entry of entries) {
        if (entry.cloneId) {
            const members = live.get(entry.cloneId) ?? [];
            members.push(entry.path);
            live.set(entry.cloneId, members);
        }
    }

    for (const candidate of candidates) {
        const hints = mirrors.flatMap((mirror) => {
            const suffix = relative(mirror.from, candidate.path);
            return suffix === "" || suffix.startsWith("..") || isAbsolute(suffix) ? [] : [join(mirror.to, suffix)];
        });
        candidate.partners = [
            ...new Set([
                ...(partners.get(candidate.cloneId ?? "") ?? []),
                ...(live.get(candidate.cloneId ?? "") ?? []),
                ...hints.filter(existsSync),
            ]),
        ].filter((partner) => partner !== candidate.path);
        candidate.privateBytes = getPrivateSize(candidate.path) ?? 0;
    }

    const view = {
        apply,
        roots,
        writer: writer.name,
        algorithm: writer.algorithm,
        writerMaxBytes: writer.maxBytes,
        olderThan: older,
        files: candidates.length,
        inputBytes: candidates.reduce((sum, candidate) => sum + candidate.alloc, 0),
        skips: first.skips,
        tooBigBytes: first.tooBigBytes,
        tooBigReason: `writer ${writer.name} limit ${writer.maxBytes} bytes; transcripts are never split`,
        candidates,
        stale: first.stale,
    };
    logger.debug(
        { roots, writer: writer.name, algorithm: writer.algorithm, files: candidates.length },
        "transparent compression plan"
    );
    if (!apply) {
        return { ...view, outcomes: [], failed: false };
    }

    // Discover mirror transaction remnants too, including files below the ordinary minimum size.
    const stale = new Set(first.stale);
    for (const mirror of mirrors) {
        for (const root of roots) {
            const suffix = relative(mirror.from, root);
            if (suffix.startsWith("..") || isAbsolute(suffix)) {
                continue;
            }

            const mirrorRoot = join(mirror.to, suffix);
            if (existsSync(mirrorRoot)) {
                for (const entry of await listCompressionFiles(mirrorRoot)) {
                    if (basename(entry.path).startsWith(".cold-")) {
                        stale.add(entry.path);
                    }
                }
            }
        }
    }

    const result = await applyTransparent({ candidates, stale: [...stale], writer, onBattery: options.onBattery });
    return {
        ...view,
        ...result,
        failed: result.outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "conflict"),
    };
}
