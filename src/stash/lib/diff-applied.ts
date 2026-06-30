import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { logger } from "@app/logger";
import { renderUnifiedDiff } from "@app/utils/diff";
import type { ApplicationRow, StashRow, VersionRow } from "../types";
import { extractRegionContentByHunk } from "./regions";
import type { StashStorage } from "./storage";
import { StoreRepo } from "./store-repo";

const { log } = logger.scoped("stash:diff-applied");

export interface DiffAppliedResult {
    regions: Array<{ filePath: string; hunkIndex: number; diff: string }>;
    exitCode: 0 | 1;
}

interface FullHunkRegion {
    filePath: string;
    hunkIndex: number;
    /** All lines that ended up inside the markers after apply: context + added (no removals). */
    content: string;
}

/**
 * Reconstruct the post-apply content of each hunk — every line that the apply command placed
 * inside the stash markers: context lines (` ` prefix) AND added lines (`+` prefix), in order.
 *
 * `collectRegionsFromPatch` only extracts added lines, which is correct for unapply decisions but
 * wrong for drift detection: `decorateAppliedRegions` wraps the full hunk range (context + added)
 * in markers, so the stored "before" must include context lines to match `extractRegionContent`.
 */
function collectFullHunkRegions(patch: string): FullHunkRegion[] {
    const results: FullHunkRegion[] = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let hunkIndex = 0;
    let inHunk = false;
    let buffer: string[] = [];
    let hasAdded = false;

    const flush = () => {
        if (currentFile && inHunk && buffer.length > 0 && hasAdded) {
            results.push({ filePath: currentFile, hunkIndex, content: buffer.join("\n") });
        }
        buffer = [];
        inHunk = false;
        hasAdded = false;
    };

    for (const line of lines) {
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) {
            flush();
            currentFile = fm[1] ?? null;
            hunkIndex = 0;
            continue;
        }

        if (line.startsWith("@@")) {
            flush();
            hunkIndex++;
            inHunk = true;
            continue;
        }

        if (!inHunk) {
            continue;
        }

        if (line.startsWith(" ")) {
            buffer.push(line.slice(1));
        } else if (line.startsWith("+")) {
            buffer.push(line.slice(1));
            hasAdded = true;
        }
        // Skip `-` lines (they were in the original, not in the post-apply region)
    }
    flush();
    return results;
}

export async function diffApplied(args: {
    name: string;
    projectRoot: string;
    db: Database;
    storage: StashStorage;
    pinnedVersion?: number;
}): Promise<DiffAppliedResult> {
    const stash = args.db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(args.name);

    if (!stash) {
        throw new Error(`stash "${args.name}" not found`);
    }

    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(stash.id, args.projectRoot);

    if (!app?.version_id) {
        throw new Error(`stash "${args.name}" is not applied in ${args.projectRoot}`);
    }

    const versionId = app.version_id;
    const version = args.pinnedVersion
        ? args.db
              .query<VersionRow, [string, number]>("SELECT * FROM versions WHERE stash_id = ? AND version = ?")
              .get(stash.id, args.pinnedVersion)
        : args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(versionId);

    if (!version) {
        throw new Error("version not found");
    }

    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regions = collectFullHunkRegions(storedPatch);
    const out: DiffAppliedResult["regions"] = [];

    for (const r of regions) {
        const abs = join(args.projectRoot, r.filePath);
        let current: string | null;

        try {
            current = await extractRegionContentByHunk(abs, args.name, r.hunkIndex);
        } catch (err) {
            log.debug({ err, filePath: r.filePath, hunkIndex: r.hunkIndex }, "applied region extraction failed");
            current = null;
        }

        const diff = renderUnifiedDiff({
            before: r.content,
            after: current ?? "",
            label: `${r.filePath}:hunk-${r.hunkIndex}`,
        });

        if (diff) {
            out.push({ filePath: r.filePath, hunkIndex: r.hunkIndex, diff });
        }
    }

    return { regions: out, exitCode: out.length > 0 ? 1 : 0 };
}
