import { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { newStashId, shortId } from "../lib/ids";
import { diffWorkingTree, listFilesInPatch, runGitIn, type SaveMode } from "../lib/patch";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:save");

export interface SaveOptions {
    name: string;
    mode: SaveMode | undefined;
    tags: string[];
    description: string | undefined;
}

export async function saveCommand(opts: SaveOptions): Promise<void> {
    log.debug({ opts }, "saveCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    log.debug({ rootPath: project.rootPath, origin: project.origin }, "project resolved");

    let mode = opts.mode;
    if (!mode) {
        if (!isInteractive()) {
            ui.err("--staged | --unstaged | --all required in non-interactive mode");
            // suggestCommand pulls the stash name from process.argv automatically; subcommand=["save"]
            // strips the duplicate `save` token that's already in toolName.
            ui.info(suggestCommand("tools stash save", { add: ["--all"], subcommand: ["save"] }));
            process.exit(1);
        }
        const { select } = await import("@clack/prompts");
        const sel = await select({
            message: "What to save?",
            options: [
                { value: "all", label: "All changes (staged + unstaged + untracked)" },
                { value: "staged", label: "Staged only" },
                { value: "unstaged", label: "Unstaged tracked changes only" },
            ],
        });
        if (typeof sel !== "string") {
            ui.warn("cancelled");
            return;
        }
        mode = sel as SaveMode;
    }
    log.debug({ mode }, "mode resolved");

    const rawPatch = await diffWorkingTree({ repoDir: project.rootPath, mode });
    if (!rawPatch.trim()) {
        ui.warn("no changes to stash");
        return;
    }
    log.debug({ rawPatchBytes: rawPatch.length }, "working-tree diff captured");

    const patch = stripApplyMarkersFromPatchFiles({ patch: rawPatch });
    const fileList = await listFilesInPatch({ repoDir: project.rootPath, patch: rawPatch });
    log.debug(
        { files: fileList.length, strippedBytes: rawPatch.length - patch.length },
        "apply-markers stripped + files listed"
    );

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const repo = new StoreRepo(storage.storeRepoDir());
    await repo.init();

    const existing = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);

    const now = new Date().toISOString();
    let stashId: string;
    let version: number;

    if (existing) {
        stashId = existing.id;
        const maxV = db
            .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
            .get(stashId);
        version = (maxV?.m ?? 0) + 1;
        ui.info(`stash "${opts.name}" exists, creating v${version}`);
        log.debug({ stashId, version, branch: "bump" }, "version bump for existing stash");
        db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, stashId]);
    } else {
        stashId = newStashId();
        version = 1;
        log.debug({ stashId, version, branch: "new" }, "new stash created");
        db.run("INSERT INTO stashes (id, name, tags, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
            stashId,
            opts.name,
            opts.tags.length ? SafeJSON.stringify(opts.tags) : null,
            opts.description ?? null,
            now,
            now,
        ]);
    }

    const patchRef = `refs/stashes/${stashId}/v${version}`;
    const baselineRef = `refs/baselines/${stashId}/v${version}`;

    const baselineFiles = await collectBaselineFiles({ projectRoot: project.rootPath, files: fileList });
    await repo.writePatchCommit({
        ref: baselineRef,
        files: baselineFiles,
        message: `stash:${opts.name} v${version} baseline`,
    });
    await repo.writePatchCommit({
        ref: patchRef,
        files: { "PATCH.diff": patch },
        message: `stash:${opts.name} v${version}`,
    });
    log.debug({ patchRef, baselineRef }, "patch + baseline refs written to store");

    const versionId = newStashId();
    db.run(
        `INSERT INTO versions (id, stash_id, version, patch_ref, source_repo_path, source_origin, source_sha, region_count, file_count, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            versionId,
            stashId,
            version,
            patchRef,
            project.rootPath,
            project.origin,
            project.sha,
            countAuthorRegionsInPatch(patch),
            fileList.length,
            SafeJSON.stringify({ mode, tags: opts.tags }),
            now,
        ]
    );

    ui.ok(`saved "${opts.name}" v${version} [id=${shortId(stashId)}]`);
    ui.info(`  ${fileList.length} files, baseline ref=${baselineRef}`);

    db.close();
    log.debug({ stashId, version, files: fileList.length }, "stash saved");
}

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
function stripApplyMarkersFromPatchFiles(args: { patch: string }): string {
    // Apply-time opener: added line matches `#region @stash:NAME {...json...}`. The JSON brace is
    // what distinguishes it from a bare author marker, which has no metadata and must be kept.
    const APPLY_OPEN_WITH_NAME = /^\+.*#region\s+@stash:([\w.-]+)\s+\{.*\}/;
    // Any added closer — used only to drop closers whose paired opener was an apply-time opener.
    const CLOSE_WITH_NAME = /^\+.*#endregion\s+@stash:([\w.-]+)/;
    // Unified-diff hunk header: `@@ -oldStart,oldLines +newStart,newLines @@ <optional ctx>`.
    const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

    const lines = args.patch.split("\n");
    const dropCloseFor = new Set<string>();
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
            dropCloseFor.add(openMatch[1]);
            droppedInHunk++;
            continue;
        }
        const closeMatch = CLOSE_WITH_NAME.exec(line);
        if (closeMatch?.[1] && dropCloseFor.has(closeMatch[1])) {
            // Only one drop per opener — supports nested same-named regions (uncommon but correct).
            dropCloseFor.delete(closeMatch[1]);
            droppedInHunk++;
            continue;
        }
        currentBody.push(line);
    }
    flushHunk();
    return out.join("\n");
}

function countAuthorRegionsInPatch(patch: string): number {
    // Count added (`+`) lines that open a `@stash:` region (includes JSON-tagged apply markers — see stripApplyMarkersFromPatchFiles).
    const m = patch.match(/^\+.*#region\s+@stash:/gm);
    return m?.length ?? 0;
}

async function collectBaselineFiles(args: { projectRoot: string; files: string[] }): Promise<Record<string, string>> {
    const baseline: Record<string, string> = {};
    for (const f of args.files) {
        try {
            baseline[f] = await runGitIn(args.projectRoot, ["show", `HEAD:${f}`]);
        } catch {
            baseline[f] = "";
        }
    }
    return baseline;
}
