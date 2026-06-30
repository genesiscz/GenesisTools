import type { Database } from "bun:sqlite";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { suggestCommand } from "@app/utils/cli";
import type { ApplicationRow, StashRow, VersionRow } from "../types";
import { classifyRegion } from "./classify";
import { applyDecisionToCode } from "./decisions";
import { renderDiff } from "./diff-render";
import { newStashId } from "./ids";
import { parseMarkers } from "./markers";
import type { DetectedProject } from "./projects";
import { splitHunksAtMarkers } from "./region-split";
import { extractRegionContentByHunk } from "./regions";
import type { StashStorage } from "./storage";
import { StoreRepo } from "./store-repo";
import { ui } from "./ui";
import { Walk, type Decision as WalkDecision, type WalkRegion } from "./walk";

const { log } = logger.scoped("stash:walk-execute");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PatchRegion {
    filePath: string;
    hunkIndex: number;
    /** Author region name from `// #region @stash:<name>` inside the hunk, or null for anonymous hunks. */
    name: string | null;
    content: string;
}

export interface ExecStats {
    removed: number;
    updated: number;
    skipped: number;
    newVersion: number | null;
    /**
     * Regions whose marker couldn't be found at execute time. When > 0, the caller must NOT mark
     * the application 'unapplied' — the user's file may still carry wrapped code (D-25 fix).
     */
    failedToFind: number;
    /** Files where a marker lookup failed — surfaced to the user for audit. */
    failedFiles: string[];
}

// v1 Decision string union defined locally so walk-execute.ts does not import from
// unapply-session. Structurally identical to `Exclude<Decision_v1, null>`; TypeScript
// accepts values of this type where that param is expected (structural typing).
type V1CodeDecision = "auto-remove" | "update" | "discard" | "skip";

/** Map v1.1 Walk decisions to the legacy verbs that applyDecisionToCode understands. */
function walkDecisionToCode(d: "auto-capture" | "capture" | "restore" | "skip"): V1CodeDecision {
    switch (d) {
        case "auto-capture":
            return "auto-remove";
        case "capture":
            return "update";
        case "restore":
            return "discard";
        case "skip":
            return "skip";
    }
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalise a v1 CLI verb ("update"/"discard") or v1.1 verb to the Walk Decision type.
 * Returns null for blanket/dangerous forms and undefined.
 */
export function normalizeUnapplyDecision(d: string | undefined): Exclude<WalkDecision, null | "auto-capture"> | null {
    if (!d || d.endsWith("-all-dangerous")) {
        return null;
    }
    switch (d) {
        case "update":
            return "capture"; // v1 alias
        case "discard":
            return "restore"; // v1 alias
        case "capture":
            return "capture";
        case "restore":
            return "restore";
        case "skip":
            return "skip";
        default:
            return null;
    }
}

/**
 * Apply a blanket decision to all undecided regions.
 * Handles "discard-all-dangerous" → restore and "update-stash-all-dangerous" → capture.
 * No-ops for other decision strings.
 */
export function applyBlanketDecision(walk: Walk, decision: string | undefined): void {
    if (!decision?.endsWith("-all-dangerous")) {
        return;
    }
    const blanket: Exclude<WalkDecision, null | "auto-capture"> =
        decision === "discard-all-dangerous" ? "restore" : "capture";
    const undecided = walk.regions().filter((r) => r.decision === null).length;
    ui.warn(`blanket decision: ${blanket} (applies to ${undecided} undecided region${undecided === 1 ? "" : "s"})`);
    log.debug({ blanket, undecided }, "blanket dangerous-decision applied");
    for (const r of walk.regions()) {
        if (r.decision === null) {
            r.decision = blanket;
        }
    }
}

// ─── Patch parsing ────────────────────────────────────────────────────────────

export function collectRegionsFromPatch(patch: string): PatchRegion[] {
    // Phase 1: parse patch into raw hunks. Each hunk's content is the full POST-IMAGE — context
    // lines (` ` prefix) AND added lines (`+` prefix), in original order. Removed (`-`) lines are
    // dropped because they aren't in the post-apply state. Earlier this function only collected
    // `+` lines, which made comparison against `extractRegionContent` (which reads the WHOLE
    // wrapped block) misleading: stored had only adds, current had context + adds, so EVERY
    // region got classified `edited` even when unchanged. Apply wraps the full hunk range
    // (`hunk.newStart .. hunk.newStart+hunk.newLines-1`), so stored must mirror that.
    const rawHunks: Array<{ filePath: string; addedLines: string[]; hasAdded: boolean }> = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let buffer: string[] = [];
    let inHunk = false;
    let hasAdded = false;

    const flush = () => {
        if (currentFile && inHunk && hasAdded) {
            // Only emit hunks that introduce at least one `+` line — pure-deletion hunks have no
            // wrapped region in the applied source (apply.ts skips them in decorateAppliedRegions).
            rawHunks.push({ filePath: currentFile, addedLines: [...buffer], hasAdded });
        }
        buffer = [];
        inHunk = false;
        hasAdded = false;
    };

    for (const line of lines) {
        // Post-image file header — captures relative path; resets per-file state.
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) {
            flush();
            currentFile = fm[1] ?? null;
            continue;
        }
        // New hunk delimiter — flush the previous hunk, start a new one.
        if (line.startsWith("@@")) {
            flush();
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            continue;
        }
        // Context line: included in post-image.
        if (line.startsWith(" ")) {
            buffer.push(line.slice(1));
            continue;
        }
        // Added line: included in post-image.
        if (line.startsWith("+")) {
            buffer.push(line.slice(1));
            hasAdded = true;
        }
        // `-` lines and `\ No newline at end of file` markers don't appear in the post-image.
    }
    flush();

    // Phase 2: split each raw hunk at author-marker boundaries (now that the buffer is the
    // full post-image, the splitter handles all line types — markers, context, additions).
    return splitHunksAtMarkers(rawHunks).map((r) => ({
        filePath: r.filePath,
        hunkIndex: r.hunkIndex,
        name: r.name,
        content: r.contentLines.join("\n"),
    }));
}

export function extractFilePathsFromPatch(patch: string): string[] {
    const paths = new Set<string>();
    for (const line of patch.split("\n")) {
        const m = /^\+\+\+ b\/(.+)$/.exec(line);
        if (m?.[1]) {
            paths.add(m[1]);
        }
    }
    return [...paths];
}

// ─── Region grouping (D-23) ───────────────────────────────────────────────────

/**
 * Group regions by filePath and sort each group in descending hunkIndex order.
 * Callers must iterate in this order so each removal doesn't shift the
 * byName[hunkIndex-1] lookup in decisions.ts for still-pending regions (D-22 / D-23 fix).
 */
export function groupRegionsByFileDescending(regions: WalkRegion[]): WalkRegion[][] {
    const byFile = new Map<string, WalkRegion[]>();
    for (const r of regions) {
        const arr = byFile.get(r.filePath) ?? [];
        arr.push(r);
        byFile.set(r.filePath, arr);
    }
    return [...byFile.values()].map((arr) => [...arr].sort((a, b) => b.hunkIndex - a.hunkIndex));
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Build a fresh Walk for an unapply session by reading the latest applied version's patch
 * and classifying each stored region against the current working-tree state.
 * Exits the process (via ui.err + process.exit) for irrecoverable configuration errors.
 */
export async function bootstrapUnapplyWalk(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    project: DetectedProject;
    projectHash: string;
}): Promise<Walk | null> {
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(args.stash.id, args.project.rootPath);
    if (!app) {
        ui.err(`"${args.stash.name}" is not applied here`);
        args.db.close();
        process.exit(1);
    }
    if (!app.version_id) {
        ui.err("application row has no version (orphaned by drop); cannot unapply");
        args.db.close();
        process.exit(1);
    }
    const version = args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);
    if (!version) {
        ui.err("version row missing");
        args.db.close();
        process.exit(1);
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regionMap = collectRegionsFromPatch(storedPatch);

    const walkRegions: WalkRegion[] = [];
    for (const r of regionMap) {
        const fileContent = await readFile(join(args.project.rootPath, r.filePath), "utf8").catch(() => null);
        const present = fileContent ? parseMarkers(fileContent).some((m) => m.name === args.stash.name) : false;
        const currentContent = fileContent
            ? await extractRegionContentByHunk(join(args.project.rootPath, r.filePath), args.stash.name, r.hunkIndex)
            : null;
        const klass = classifyRegion({ storedContent: r.content, currentContent, present }).klass;
        walkRegions.push({
            id: newStashId(),
            filePath: r.filePath,
            hunkIndex: r.hunkIndex,
            name: r.name,
            klass,
            // unchanged regions get auto-capture: stripped without interactive prompting
            decision: klass === "unchanged" ? "auto-capture" : null,
            storedContent: r.content,
            currentContent,
        });
    }

    const walk = await Walk.start({
        verb: "unapply",
        stashId: args.stash.id,
        stashName: args.stash.name,
        projectPath: args.project.rootPath,
        projectHash: args.projectHash,
        regions: walkRegions,
        stateDir: args.storage.stateDir(),
        extension: {},
    });
    log.debug(
        {
            regionsTotal: walk.regions().length,
            autoCapture: walk.regions().filter((r) => r.decision === "auto-capture").length,
        },
        "walk bootstrapped"
    );
    return walk;
}

// ─── Auto-capture processing ─────────────────────────────────────────────────

/**
 * Strip all auto-capture (unchanged) regions from disk before interactive walk.
 * Iterates per-file in descending hunkIndex order (D-23: prevents line-number shift).
 */
export async function processAutoRemoves(args: { walk: Walk; projectRoot: string }): Promise<void> {
    for (const regions of groupRegionsByFileDescending(args.walk.regions())) {
        for (const r of regions) {
            if (r.decision === "auto-capture") {
                await applyDecisionToCode({
                    filePath: join(args.projectRoot, r.filePath),
                    regionName: r.name ?? args.walk.snapshot().stashName,
                    hunkIndex: r.hunkIndex,
                    decision: "auto-remove",
                });
            }
        }
    }
}

// ─── Interactive walk ─────────────────────────────────────────────────────────

export async function walkInteractive(args: { walk: Walk; verb: string }): Promise<void> {
    const { select, note } = await import("@clack/prompts");
    while (!args.walk.isComplete()) {
        const region = args.walk.currentRegion();
        if (!region) {
            return;
        }
        const total = args.walk.regions().length;
        const idx = args.walk.snapshot().currentIndex + 1;
        const diff = renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        });
        note(diff, `Region ${idx}/${total} — class: ${region.klass}`);
        const selectOpts: Array<{ value: Exclude<WalkDecision, null | "auto-capture">; label: string }> = [
            { value: "capture", label: "capture — save current as new vN+1, then remove" },
            { value: "restore", label: "restore — remove using stored content (lose local edits)" },
            { value: "skip", label: "skip — leave code and store alone (warns)" },
        ];
        if (region.klass === "missing") {
            selectOpts.splice(1, 1);
        }
        const sel = await select({ message: "decision?", options: selectOpts });
        if (typeof sel !== "string") {
            ui.warn(`paused; resume with: tools stash ${args.verb} ${args.walk.snapshot().stashName} --continue`);
            await args.walk.persist();
            process.exit(0);
        }
        args.walk.decide(sel as Exclude<WalkDecision, null | "auto-capture">);
    }
}

export async function emitNonTtyPrompt(args: { walk: Walk; verb: string }): Promise<void> {
    const region = args.walk.currentRegion();
    if (!region) {
        return;
    }
    const total = args.walk.regions().length;
    const idx = args.walk.snapshot().currentIndex + 1;
    process.stderr.write(
        `\nRegion ${idx}/${total} — ${region.filePath} hunk ${region.hunkIndex} (class: ${region.klass})\n`
    );
    process.stderr.write(
        renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        })
    );
    process.stderr.write("\nChoose a decision:\n");
    const cmdName = `tools stash ${args.verb}`;
    // Strip any prior `--continue` / `--decision=*` / `--skip` / `--abort` / `--status` so the
    // suggested next-step is a fresh single decision, not a concatenation of previous ones.
    const removePrev = ["--continue", "--decision", "--skip", "--abort", "--status"];
    for (const dec of ["capture", "restore", "skip"]) {
        process.stderr.write(
            `  ${suggestCommand(cmdName, {
                remove: removePrev,
                add: ["--continue", `--decision=${dec}`],
                subcommand: [args.verb],
            })}\n`
        );
    }
    process.stderr.write(
        `Or abort:\n  ${suggestCommand(cmdName, {
            remove: removePrev,
            add: ["--abort"],
            subcommand: [args.verb],
        })}\n`
    );
}

// ─── Execute decisions ────────────────────────────────────────────────────────

export async function executeUnapplyDecisions(args: {
    walk: Walk;
    projectRoot: string;
    storage: StashStorage;
    db: Database;
    stash: StashRow;
}): Promise<ExecStats> {
    const stats: ExecStats = {
        removed: 0,
        updated: 0,
        skipped: 0,
        newVersion: null,
        failedToFind: 0,
        failedFiles: [],
    };
    const createdFiles = await deriveCreatedFilesFromBaseline({
        db: args.db,
        storage: args.storage,
        stashId: args.stash.id,
        projectPath: args.walk.snapshot().projectPath,
    });
    // Snapshot "capture"-bound regions before mutating disk.
    const capturedRegions: WalkRegion[] = args.walk.regions().filter((r) => r.decision === "capture");
    for (const r of args.walk.regions()) {
        if (r.decision === "skip") {
            stats.skipped++;
            ui.warn(`region ${r.filePath} hunk ${r.hunkIndex}: kept (stash and code now diverged)`);
        } else if (r.decision === "auto-capture" || r.decision === "restore" || r.decision === "capture") {
            if (r.decision === "capture") {
                stats.updated++;
            }
            stats.removed++;
        }
    }
    // Apply mutations per-file, back-to-front (D-23). auto-capture regions were already
    // stripped by processAutoRemoves; calling applyDecisionToCode on them again would log a
    // spurious "no marker" warn — only process restore/capture here.
    for (const regions of groupRegionsByFileDescending(args.walk.regions())) {
        for (const r of regions) {
            if (r.decision !== "restore" && r.decision !== "capture") {
                continue;
            }
            const outcome = await applyDecisionToCode({
                filePath: join(args.projectRoot, r.filePath),
                regionName: r.name ?? args.walk.snapshot().stashName,
                hunkIndex: r.hunkIndex,
                decision: walkDecisionToCode(r.decision),
            });
            if (outcome === "marker-missing") {
                stats.failedToFind++;
                if (!stats.failedFiles.includes(r.filePath)) {
                    stats.failedFiles.push(r.filePath);
                }
            }
        }
    }
    if (capturedRegions.length) {
        stats.newVersion = await capturedUpdatesAsNewVersion({
            storage: args.storage,
            db: args.db,
            stash: args.stash,
            capturedRegions,
        });
    }
    await unlinkEmptyCreatedFiles({ projectRoot: args.projectRoot, createdFiles });
    return stats;
}

// ─── Created-files tracking ───────────────────────────────────────────────────

/**
 * Derive "files that existed only inside the overlay" from the stored BASELINE ref.
 * A baseline blob that is null or empty means the file had no HEAD content when saved.
 */
export async function deriveCreatedFilesFromBaseline(args: {
    db: Database;
    storage: StashStorage;
    stashId: string;
    projectPath: string;
}): Promise<string[]> {
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(args.stashId, args.projectPath);
    if (!app?.version_id) {
        return [];
    }
    const version = args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);
    if (!version) {
        return [];
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const baselineRef = `refs/baselines/${args.stashId}/v${version.version}`;
    const patch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const filesInPatch = extractFilePathsFromPatch(patch);
    const created: string[] = [];
    for (const path of filesInPatch) {
        const baseline = await repo.readFileAt(baselineRef, path);
        if (baseline === null || baseline === "") {
            created.push(path);
        }
    }
    log.debug({ version_id: version.id, created }, "derived createdFiles from baseline ref");
    return created;
}

export async function unlinkEmptyCreatedFiles(args: { projectRoot: string; createdFiles: string[] }): Promise<void> {
    for (const rel of args.createdFiles) {
        const abs = join(args.projectRoot, rel);
        let content: string;
        try {
            content = await readFile(abs, "utf8");
        } catch (err) {
            log.debug({ err, rel }, "created-file readback failed (already gone?); skipping unlink");
            continue;
        }
        if (content.trim() !== "") {
            log.debug({ rel, bytes: content.length }, "created-file has content (likely 'skip'); not unlinking");
            continue;
        }
        try {
            await unlink(abs);
            log.debug({ rel }, "unlinked empty husk left by unapply of new-file overlay");
        } catch (err) {
            log.warn({ err, rel }, "failed to unlink empty husk; user may need to remove manually");
        }
    }
}

// ─── Version capture ─────────────────────────────────────────────────────────

/**
 * Persist the user's `capture` decisions as a new stash version (v1.1 counterpart of
 * the v1 "update" decision). Builds a real unified diff per region and writes it to
 * the bare store repo.
 */
export async function capturedUpdatesAsNewVersion(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    capturedRegions: WalkRegion[];
}): Promise<number> {
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const maxV = args.db
        .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
        .get(args.stash.id);
    const newV = (maxV?.m ?? 0) + 1;

    const patchParts: string[] = [];
    for (const r of args.capturedRegions) {
        const before = r.storedContent ?? "";
        const after = r.currentContent ?? "";
        patchParts.push(buildUnifiedDiff({ path: r.filePath, before, after }));
    }
    const patch = patchParts.join("");
    const patchRef = `refs/stashes/${args.stash.id}/v${newV}`;
    const baselineRef = `refs/baselines/${args.stash.id}/v${newV}`;
    const baselineFiles: Record<string, string> = {};
    for (const r of args.capturedRegions) {
        baselineFiles[r.filePath] = r.storedContent ?? "";
    }
    await repo.writePatchCommit({
        ref: baselineRef,
        files: baselineFiles,
        message: `stash:${args.stash.name} v${newV} baseline (captured)`,
    });
    await repo.writePatchCommit({
        ref: patchRef,
        files: { "PATCH.diff": patch },
        message: `stash:${args.stash.name} v${newV} (captured from unapply)`,
    });
    log.debug({ patchRef, baselineRef, regions: args.capturedRegions.length }, "captured-from-unapply version written");

    const now = new Date().toISOString();
    const newVersionId = newStashId();
    args.db.run(
        `INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{"capturedFromUnapply":true}', ?)`,
        [
            newVersionId,
            args.stash.id,
            newV,
            patchRef,
            args.capturedRegions.length,
            new Set(args.capturedRegions.map((r) => r.filePath)).size,
            now,
        ]
    );

    for (const r of args.capturedRegions) {
        args.db.run(
            `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                newStashId(),
                newVersionId,
                args.stash.name,
                r.filePath,
                r.hunkIndex,
                1,
                r.currentContent ? r.currentContent.split("\n").length : 0,
            ]
        );
    }

    args.db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, args.stash.id]);
    return newV;
}

// ─── Update bootstrap + execute ──────────────────────────────────────────────

/**
 * Build a fresh Walk for an update session. Reads the active application's stored patch,
 * classifies each region against the current on-disk state, and seeds the walk extension with
 * `{ currentVersionId, targetVNext }` so executeUpdateDecisions can advance the application.
 *
 * Throws (instead of process.exit) so callers in test contexts can catch the error.
 */
export async function bootstrapUpdateWalk(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    project: DetectedProject;
    projectHash: string;
}): Promise<Walk> {
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(args.stash.id, args.project.rootPath);

    if (!app) {
        throw new Error(`"${args.stash.name}" is not applied here — use 'apply' first then 'update'`);
    }

    if (!app.version_id) {
        throw new Error("application row has no version (orphaned); cannot update");
    }

    const version = args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);

    if (!version) {
        throw new Error("version row missing for active application; cannot update");
    }

    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regionMap = collectRegionsFromPatch(storedPatch);

    const walkRegions: WalkRegion[] = [];

    for (const r of regionMap) {
        const fileContent = await readFile(join(args.project.rootPath, r.filePath), "utf8").catch(() => null);
        const present = fileContent ? parseMarkers(fileContent).some((m) => m.name === args.stash.name) : false;
        const currentContent = fileContent
            ? await extractRegionContentByHunk(join(args.project.rootPath, r.filePath), args.stash.name, r.hunkIndex)
            : null;
        const klass = classifyRegion({ storedContent: r.content, currentContent, present }).klass;
        walkRegions.push({
            id: newStashId(),
            filePath: r.filePath,
            hunkIndex: r.hunkIndex,
            name: r.name,
            klass,
            // unchanged regions get auto-capture: accepted into v_next without prompting
            decision: klass === "unchanged" ? "auto-capture" : null,
            storedContent: r.content,
            currentContent,
        });
    }

    const maxV = args.db
        .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
        .get(args.stash.id);
    const targetVNext = (maxV?.m ?? 0) + 1;

    log.debug({ stashId: args.stash.id, regions: walkRegions.length, targetVNext }, "update walk bootstrapped");

    return Walk.start({
        verb: "update",
        stashId: args.stash.id,
        stashName: args.stash.name,
        projectPath: args.project.rootPath,
        projectHash: args.projectHash,
        regions: walkRegions,
        stateDir: args.storage.stateDir(),
        extension: { currentVersionId: version.id, targetVNext },
    });
}

/**
 * Execute resolved decisions for an update walk:
 * - `restore`: rewrite code between markers to stored content (markers preserved, stash stays applied)
 * - `capture` | `auto-capture`: record current code as a new version; advance applications.version_id
 * - `skip`: no-op (emits a warning)
 */
export async function executeUpdateDecisions(args: {
    walk: Walk;
    projectRoot: string;
    storage: StashStorage;
    db: Database;
    stash: StashRow;
}): Promise<void> {
    const ext = args.walk.snapshot().extension as { currentVersionId: string; targetVNext: number };
    const captureRegions = args.walk.regions().filter((r) => r.decision === "capture" || r.decision === "auto-capture");
    const restoreRegions = args.walk.regions().filter((r) => r.decision === "restore");
    const skippedRegions = args.walk.regions().filter((r) => r.decision === "skip");

    // 1. Restore: rewrite code between markers to stored content (D-22 hunkIndex indexing preserved).
    for (const r of restoreRegions) {
        const abs = join(args.projectRoot, r.filePath);
        const content = await readFile(abs, "utf8").catch(() => null);

        if (!content) {
            log.warn({ rel: r.filePath }, "restore: file missing; skipping");
            continue;
        }

        const byName = parseMarkers(content).filter((m) => m.name === args.stash.name);
        const marker = byName[r.hunkIndex - 1];

        if (!marker) {
            log.warn({ rel: r.filePath, hunkIndex: r.hunkIndex }, "restore: marker not found; skipping");
            continue;
        }

        const lines = content.split("\n");
        const before = lines.slice(0, marker.contentStartLine - 1);
        const restored = (r.storedContent ?? "").split("\n");
        const after = lines.slice(marker.contentEndLine);
        await writeFile(abs, [...before, ...restored, ...after].join("\n"));
    }

    // 2. Capture: build v_next patch, persist to store, advance applications.version_id.
    if (captureRegions.length > 0) {
        const repo = new StoreRepo(args.storage.storeRepoDir());
        const newV = ext.targetVNext;
        const patchRef = `refs/stashes/${args.stash.id}/v${newV}`;
        const baselineRef = `refs/baselines/${args.stash.id}/v${newV}`;

        const patch = captureRegions
            .map((r) =>
                buildUnifiedDiff({
                    path: r.filePath,
                    before: r.storedContent ?? "",
                    after: r.currentContent ?? "",
                })
            )
            .join("");

        const baselineFiles: Record<string, string> = {};

        for (const r of captureRegions) {
            baselineFiles[r.filePath] = r.storedContent ?? "";
        }

        await repo.writePatchCommit({
            ref: baselineRef,
            files: baselineFiles,
            message: `stash:${args.stash.name} v${newV} baseline (update capture)`,
        });
        await repo.writePatchCommit({
            ref: patchRef,
            files: { "PATCH.diff": patch },
            message: `stash:${args.stash.name} v${newV} (captured from update)`,
        });

        const now = new Date().toISOString();
        const newVersionId = newStashId();
        args.db.run(
            `INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, '{"capturedFromUpdate":true}', ?)`,
            [
                newVersionId,
                args.stash.id,
                newV,
                patchRef,
                captureRegions.length,
                new Set(captureRegions.map((r) => r.filePath)).size,
                now,
            ]
        );

        for (const r of captureRegions) {
            args.db.run(
                `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    newStashId(),
                    newVersionId,
                    args.stash.name,
                    r.filePath,
                    r.hunkIndex,
                    1,
                    r.currentContent ? r.currentContent.split("\n").length : 0,
                ]
            );
        }

        args.db.run(
            "UPDATE applications SET version_id = ? WHERE stash_id = ? AND project_path = ? AND state = 'active'",
            [newVersionId, args.stash.id, args.walk.snapshot().projectPath]
        );
        args.db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, args.stash.id]);
        log.debug({ patchRef, baselineRef, regions: captureRegions.length, newV }, "update: v_next written");
        ui.ok(`captured ${captureRegions.length} region(s) to v${newV}; application now pinned to v${newV}`);
    } else {
        ui.info("no capture decisions; v_next not written");
    }

    if (restoreRegions.length > 0) {
        ui.info(`restored ${restoreRegions.length} region(s) in code`);
    }

    if (skippedRegions.length > 0) {
        ui.warn(`${skippedRegions.length} region(s) skipped (stash and code diverged)`);
    }
}

/** Minimal single-file unified diff between `before` and `after` content. */
export function buildUnifiedDiff(args: { path: string; before: string; after: string }): string {
    const beforeLines = args.before === "" ? [] : args.before.split("\n");
    const afterLines = args.after === "" ? [] : args.after.split("\n");
    const header = [
        `--- a/${args.path}`,
        `+++ b/${args.path}`,
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ].join("\n");
    const body = [...beforeLines.map((l) => `-${l}`), ...afterLines.map((l) => `+${l}`)].join("\n");
    return `${header}\n${body}\n`;
}
