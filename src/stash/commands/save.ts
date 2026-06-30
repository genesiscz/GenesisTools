import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { renderUnifiedDiff } from "@app/utils/diff";
import { SafeJSON } from "@app/utils/json";
import { newStashId, shortId } from "../lib/ids";
import { parseMarkers } from "../lib/markers";
import { parseRegionsFromPatch } from "../lib/parse-regions";
import { diffWorkingTree, listFilesInPatch, runGitIn, type SaveMode } from "../lib/patch";
import { pickPatchInteractively } from "../lib/patch-picker";
import { detectProject } from "../lib/projects";
import { discoverRegionsInTree } from "../lib/regions";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { stripApplyMarkersFromPatchFiles } from "../lib/strip-apply-markers";
import { ui } from "../lib/ui";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:save");

/**
 * When saving over an existing stash name, render the aggregate v_prev → v_next diff and ask
 * the user to confirm before bumping. Per spec §6.2 and §15.1 — NOT a per-region walk.
 *
 * Returns "abort" when:
 *   - prevPatch === nextPatch (no change — nothing to bump)
 *   - non-TTY without forceBump (prints error + suggestion to stderr)
 *   - user answers "no" in interactive TTY
 *
 * Returns "proceed" when:
 *   - forceBump is true (bypasses prompt even in non-TTY)
 *   - user answers "yes" in interactive TTY
 */
async function maybePromptSameName(args: {
    existingName: string;
    prevPatch: string;
    nextPatch: string;
    forceBump: boolean;
}): Promise<"proceed" | "abort"> {
    const diff = renderUnifiedDiff({ before: args.prevPatch, after: args.nextPatch, label: "PATCH.diff" });

    if (diff === "") {
        ui.warn(`"${args.existingName}" already exists with identical changes — nothing to bump`);
        return "abort";
    }

    if (args.forceBump) {
        return "proceed";
    }

    if (!isInteractive()) {
        ui.err(
            `"${args.existingName}" already exists; in non-TTY mode pass --force-bump to write v_next without prompting`
        );
        ui.info("  working-tree diff vs v_prev:");
        process.stderr.write(`${diff}\n`);
        return "abort";
    }

    const { confirm, note } = await import("@clack/prompts");
    note(diff, `Aggregate diff: v_prev → v_next for "${args.existingName}"`);
    const answer = await confirm({
        message: `Bump "${args.existingName}" to a new version with these changes?`,
        active: "yes (write v_next)",
        inactive: "no (abort)",
    });

    return answer === true ? "proceed" : "abort";
}

export interface SaveOptions {
    name: string;
    mode: SaveMode | undefined;
    /**
     * Author-marker region names to filter the captured patch by. When set, only hunks whose
     * post-image lines overlap with at least one `// #region @stash:<name>` block in the working
     * tree are kept. Combines with `mode` — defaults to `all` when only `regions` is provided.
     */
    regions?: string[];
    tags: string[];
    description: string | undefined;
    /**
     * When the stash name already exists, skip the aggregate diff confirm prompt and write v_next
     * silently. Required in non-TTY mode when saving over an existing name.
     */
    forceBump?: boolean;
}

export async function saveCommand(opts: SaveOptions): Promise<void> {
    log.debug({ opts }, "saveCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    log.debug({ rootPath: project.rootPath, origin: project.origin }, "project resolved");

    // Region-name list to filter by; resolved from `--regions` flag OR interactive multi-select.
    // Empty array means "no region filter active" (save everything per `mode`).
    let regionNames: string[] = opts.regions ?? [];

    let mode = opts.mode;
    if (!mode && regionNames.length === 0) {
        if (!isInteractive()) {
            ui.err("--mode <staged|unstaged|all> or --regions required in non-interactive mode");
            // suggestCommand pulls the stash name from process.argv automatically; subcommand=["save"]
            // strips the duplicate `save` token that's already in toolName.
            ui.info(suggestCommand("tools stash save", { add: ["--mode", "all"], subcommand: ["save"] }));
            process.exit(1);
        }
        const { select } = await import("@clack/prompts");
        const sel = await select({
            message: "What to save?",
            options: [
                { value: "all", label: "All changes (staged + unstaged + untracked)" },
                { value: "staged", label: "Staged only" },
                { value: "unstaged", label: "Unstaged tracked changes only" },
                { value: "regions", label: "Marked regions (// #region @stash:<name> blocks in changed files)" },
                { value: "patch", label: "Interactive hunk picker (git-add-p style)" },
            ],
        });
        if (typeof sel !== "string") {
            ui.warn("cancelled");
            return;
        }
        if (sel === "regions") {
            const picked = await pickRegionsInteractively({ projectRoot: project.rootPath, name: opts.name });
            if (!picked) {
                return;
            }
            regionNames = picked;
            mode = "regions";
        } else {
            mode = sel as SaveMode;
        }
    }
    if (!mode) {
        // Programmatic callers must pass mode explicitly; interactive and CLI paths always set it above.
        ui.err("--mode <staged|unstaged|all|regions> required");
        process.exit(1);
    }
    log.debug({ mode, regionNames }, "mode resolved");

    const rawPatch = await diffWorkingTree({ repoDir: project.rootPath, mode });
    if (!rawPatch.trim()) {
        ui.warn("no changes to stash");
        return;
    }
    log.debug({ rawPatchBytes: rawPatch.length }, "working-tree diff captured");

    let filteredPatch = rawPatch;

    if (mode === "patch") {
        if (!isInteractive()) {
            ui.err("--mode patch requires a TTY");
            process.exit(1);
        }

        const picked = await pickPatchInteractively({ patch: rawPatch });

        if (!picked.kept.trim()) {
            ui.warn("no hunks selected; nothing to save");
            return;
        }

        filteredPatch = picked.kept;
        log.debug({ kept: picked.kept.length, dropped: picked.droppedCount }, "patch mode: hunk picker result");
    }

    if (regionNames.length > 0) {
        const filtered = await filterPatchToAuthorRegions({
            projectRoot: project.rootPath,
            patch: rawPatch,
            regionNames,
        });
        if (!filtered.trim()) {
            ui.err(
                `no hunks overlap with the requested region(s): ${regionNames.join(", ")} — did you mark the blocks and stage/modify the surrounding code?`
            );
            process.exit(1);
        }
        filteredPatch = filtered;
        log.debug(
            { kept: filteredPatch.length, dropped: rawPatch.length - filteredPatch.length, regionNames },
            "patch filtered by region overlap"
        );
    }

    const patch = stripApplyMarkersFromPatchFiles({ patch: filteredPatch });

    if (!patch.trim()) {
        ui.warn("no changes to stash after stripping apply markers");
        process.exit(1);
    }

    // Derive file_count and baseline capture from the patch that's actually stored (post-strip),
    // not the pre-strip filteredPatch — otherwise stripping the only changes for a file leaves
    // it counted but absent from PATCH.diff.
    const fileList = await listFilesInPatch({ repoDir: project.rootPath, patch });
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
        const prevVersion = maxV?.m ?? 0;
        version = prevVersion + 1;

        // Show aggregate v_prev → v_working diff and prompt before bumping.
        const prevPatchRef = `refs/stashes/${stashId}/v${prevVersion}`;
        const prevPatch = prevVersion > 0 ? ((await repo.readFileAt(prevPatchRef, "PATCH.diff")) ?? "") : "";
        const decision = await maybePromptSameName({
            existingName: opts.name,
            prevPatch,
            nextPatch: patch,
            forceBump: opts.forceBump ?? false,
        });

        if (decision === "abort") {
            ui.info(`save aborted; "${opts.name}" stays at v${prevVersion}`);
            db.close();
            return;
        }

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

    // Pre-compute parsed regions so the INSERT below uses the same array length the regions-table
    // loop will insert. Keeps `versions.region_count` consistent with the per-row inventory.
    const patchRegions = parseRegionsFromPatch(patch);

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
            // `region_count` = number of rows inserted into the regions table below (one per hunk).
            // Earlier this used `countAuthorRegionsInPatch` (= count of `@stash:` markers in `+`
            // lines), which returned 0 for typical non-marker saves while the regions table got
            // populated with N rows — `tools stash show <name>` then displayed both numbers and
            // looked broken. Keeping these two counts identical is the simplest fix.
            patchRegions.length,
            fileList.length,
            SafeJSON.stringify({ mode, tags: opts.tags }),
            now,
        ]
    );

    for (const r of patchRegions) {
        db.run(
            "INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [newStashId(), versionId, r.regionName, r.filePath, r.hunkIndex, r.startMarkerPresent ? 1 : 0, r.lineCount]
        );
    }

    ui.ok(`saved "${opts.name}" v${version} [id=${shortId(stashId)}]`);
    ui.info(`  ${fileList.length} files, baseline ref=${baselineRef}`);
    emitPostSaveHints({ name: opts.name, mode, files: fileList });

    db.close();
    log.debug({ stashId, version, files: fileList.length }, "stash saved");
}

/**
 * After a successful save, explicitly tell the user that the working tree was NOT modified —
 * `tools stash` is overlay-capture (spec §7.1: "Mutates code: No"), not git-stash. Then offer a
 * mode-aware, **recoverable** wipe command using `git stash push`. Recoverable on purpose: this
 * tool captures a subset of files, so a destructive wipe could silently delete work that wasn't
 * actually saved here.
 */
function emitPostSaveHints(args: { name: string; mode: SaveMode; files: string[] }): void {
    ui.warn("working tree is unchanged — this captured an overlay, it did NOT remove the changes");
    const fileList = args.files.length ? ` -- ${args.files.map(quoteIfSpaces).join(" ")}` : "";
    if (args.mode === "staged") {
        // `git stash push --staged` (git 2.35+) shelves index-only changes; unstaged + untracked stay.
        ui.info(`  to clear the staged changes (recoverable):  git stash push --staged -m "${args.name}"${fileList}`);
    } else if (args.mode === "unstaged") {
        // `--keep-index` shelves only worktree-vs-index diff, leaves the index intact.
        ui.info(
            `  to clear the unstaged changes (recoverable): git stash push --keep-index -m "${args.name}"${fileList}`
        );
    } else {
        // `-u`/`--include-untracked` so brand-new files come along into the git-stash too.
        ui.info(`  to clear all captured changes (recoverable): git stash push -u -m "${args.name}"${fileList}`);
    }
    ui.info(`  to apply this overlay in another project:    cd <other-project> && tools stash apply ${args.name}`);
}

function quoteIfSpaces(p: string): string {
    return p.includes(" ") ? `"${p}"` : p;
}

/**
 * Interactive "Marked regions" branch — discover author `// #region @stash:<name>` blocks in
 * the working tree and let the user multi-select which ones to capture.
 *
 * Returns:
 *   - `null` when there are no markers (instructions emitted) or when the user cancels.
 *   - A non-empty array of region NAMES to filter by. Caller threads this into the save flow as
 *     `regionNames`; the filter keeps only hunks whose post-image lines overlap with at least one
 *     of the named regions' line spans in the working tree.
 */
async function pickRegionsInteractively(args: { projectRoot: string; name: string }): Promise<string[] | null> {
    const all = await discoverRegionsInTree(args.projectRoot);
    log.debug({ found: all.length }, "marked-regions: scan complete");
    if (all.length === 0) {
        emitMarkerAuthoringInstructions(args.name);
        return null;
    }
    const byName = new Map<string, Array<{ file: string; startLine: number; endLine: number }>>();
    for (const r of all) {
        const arr = byName.get(r.name) ?? [];
        arr.push({ file: r.filePath, startLine: r.startLine, endLine: r.endLine });
        byName.set(r.name, arr);
    }
    const { multiselect } = await import("@clack/prompts");
    const sel = await multiselect({
        message: `Pick regions to include in stash "${args.name}":`,
        // The region name is the author marker tag (`@stash:<region-name>`), NOT the stash name —
        // they're independent. We surface the file:line span as a hint so duplicates with the same
        // tag (e.g. two `@stash:debug-logger` blocks across files) stay distinguishable.
        options: [...byName.entries()].map(([n, hits]) => ({
            value: n,
            label: `@stash:${n}`,
            hint: hits.map((h) => `${h.file}:${h.startLine}-${h.endLine}`).join(", "),
        })),
        required: true,
    });
    if (!Array.isArray(sel) || sel.length === 0) {
        ui.warn("cancelled");
        return null;
    }
    return sel as string[];
}

function emitMarkerAuthoringInstructions(name: string): void {
    ui.warn("no `@stash:` author markers found anywhere in the working tree");
    ui.raw("");
    ui.info("Two related but DIFFERENT names are at play:");
    ui.raw(`    stash name = "${name}"                ← the store key (positional arg of save)`);
    ui.raw("    region name = whatever you tag       ← appears in source as @stash:<region-name>");
    ui.raw("");
    ui.info("Mark the code blocks you want to stash like this (foldable in editors):");
    ui.raw("");
    ui.raw(`    // #region @stash:${name}`);
    ui.raw("    const log = createDebugLogger();");
    ui.raw("    log.debug('hi');");
    ui.raw(`    // #endregion @stash:${name}`);
    ui.raw("");
    ui.info(`Convention: name the region the same as the stash (here, "${name}") so the two stay aligned.`);
    ui.info("Comment syntax adapts per language (# for Python/Ruby/Bash; <!-- --> for HTML/MD; /* */ for CSS).");
    ui.raw("");
    ui.info("Then re-run with --regions:");
    ui.raw(`    tools stash save ${name} --regions ${name}`);
    ui.info("Or capture everything without marking individual regions:");
    ui.raw(`    tools stash save ${name} --mode all`);
    ui.raw(`    tools stash save ${name} --mode staged`);
    ui.raw(`    tools stash save ${name} --mode unstaged`);
}

/**
 * Filter a unified diff to keep only hunks whose post-image (`+`) line range overlaps with at
 * least one author `// #region @stash:<name>` block (matching one of `regionNames`) in the
 * working-tree file. Per-file file headers ARE preserved; files with no surviving hunks are
 * dropped entirely.
 *
 * "Overlap" means: hunk's post-image `[newStart, newStart+newLines)` intersects the region's
 * `[startLine, endLine]` (inclusive of marker lines themselves). Conservative — we err toward
 * including more context rather than slicing hunks apart, which would require recomputing
 * hunk headers and is the "non-trivial" risk the plan flagged.
 */
async function filterPatchToAuthorRegions(args: {
    projectRoot: string;
    patch: string;
    regionNames: string[];
}): Promise<string> {
    const wanted = new Set(args.regionNames);
    // Per-file region line spans, sourced from the CURRENT working tree (apply-target lines).
    // We compare against post-image `+newStart` because that's the same coordinate space —
    // both describe the file after the user's edits.
    const regionSpansByFile = new Map<string, Array<{ start: number; end: number }>>();
    const files = parsePatchFileList(args.patch);
    for (const file of files) {
        let content: string;
        try {
            content = await readFile(join(args.projectRoot, file), "utf8");
        } catch (err) {
            log.debug({ err, file }, "filter: file unreadable in working tree; no spans");
            continue;
        }
        const spans: Array<{ start: number; end: number }> = [];
        for (const m of parseMarkers(content)) {
            if (wanted.has(m.name)) {
                spans.push({ start: m.startLine, end: m.endLine });
            }
        }
        if (spans.length) {
            regionSpansByFile.set(file, spans);
        }
    }
    if (regionSpansByFile.size === 0) {
        return "";
    }
    return filterHunksByFileSpans({ patch: args.patch, regionSpansByFile });
}

function parsePatchFileList(patch: string): string[] {
    const out = new Set<string>();
    for (const line of patch.split("\n")) {
        // `+++ b/<path>` is the post-image header from `git diff --dst-prefix=b/`. Same source of
        // truth used everywhere else (listFilesInPatch fallback, collectRegionsFromPatch).
        const m = /^\+\+\+ b\/(.+)$/.exec(line);
        if (m?.[1]) {
            out.add(m[1]);
        }
    }
    return [...out];
}

interface FileBlock {
    headerLines: string[];
    /** Hunks are `{ headerLine, bodyLines }` so we can keep or drop the hunk header alongside its body. */
    hunks: Array<{ headerLine: string; bodyLines: string[]; newStart: number; newLines: number }>;
}

function filterHunksByFileSpans(args: {
    patch: string;
    regionSpansByFile: Map<string, Array<{ start: number; end: number }>>;
}): string {
    const blocks = parsePatchIntoFileBlocks(args.patch);
    const kept: string[] = [];
    for (const block of blocks) {
        const file = extractFileFromBlock(block);
        if (!file) {
            continue;
        }
        const spans = args.regionSpansByFile.get(file);
        if (!spans?.length) {
            continue;
        }
        const survivingHunks = block.hunks.filter((h) => spans.some((s) => rangesOverlap(h, s)));
        if (!survivingHunks.length) {
            continue;
        }
        kept.push(block.headerLines.join("\n"));
        for (const h of survivingHunks) {
            kept.push(h.headerLine);
            if (h.bodyLines.length) {
                kept.push(h.bodyLines.join("\n"));
            }
        }
    }
    if (kept.length === 0) {
        return "";
    }
    // Trailing newline matches `git diff` output convention — `git apply` is lenient either way
    // but keeping it consistent avoids surprises in downstream regex'es that anchor on it.
    return `${kept.join("\n")}\n`;
}

function rangesOverlap(h: { newStart: number; newLines: number }, s: { start: number; end: number }): boolean {
    // Hunk post-image lines occupy [newStart, newStart + newLines - 1] in the modified file
    // (1-indexed). Spans are inclusive [start, end]. Overlap iff they share at least one line.
    const hunkEnd = h.newStart + Math.max(0, h.newLines - 1);
    return h.newStart <= s.end && s.start <= hunkEnd;
}

function parsePatchIntoFileBlocks(patch: string): FileBlock[] {
    // Standard `git diff` blocks start with `diff --git a/<a> b/<b>` (one block per file). Inside,
    // header lines run until the first `@@` hunk header; everything after is hunks until the next
    // `diff --git` boundary.
    const blocks: FileBlock[] = [];
    let current: FileBlock | null = null;
    let currentHunk: FileBlock["hunks"][number] | null = null;
    let inHeader = true;
    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            if (current) {
                blocks.push(current);
            }
            current = { headerLines: [line], hunks: [] };
            currentHunk = null;
            inHeader = true;
            continue;
        }
        if (!current) {
            continue;
        }
        if (line.startsWith("@@ ")) {
            const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (m) {
                currentHunk = {
                    headerLine: line,
                    bodyLines: [],
                    newStart: Number(m[1]),
                    newLines: Number(m[2] ?? "1"),
                };
                current.hunks.push(currentHunk);
                inHeader = false;
                continue;
            }
        }
        if (inHeader) {
            current.headerLines.push(line);
        } else if (currentHunk) {
            currentHunk.bodyLines.push(line);
        }
    }
    if (current) {
        blocks.push(current);
    }
    return blocks;
}

function extractFileFromBlock(block: FileBlock): string | null {
    for (const line of block.headerLines) {
        const m = /^\+\+\+ b\/(.+)$/.exec(line);
        if (m?.[1]) {
            return m[1];
        }
    }
    return null;
}

async function collectBaselineFiles(args: { projectRoot: string; files: string[] }): Promise<Record<string, string>> {
    const baseline: Record<string, string> = {};
    // Empty-string baseline for files that don't exist at HEAD ("created at save time"). Unapply
    // detects this case by reading the baseline ref and treating empty/missing blobs as "the
    // overlay introduced this file" — that's how the husk-cleanup avoids leaving 0-byte files.
    for (const f of args.files) {
        try {
            baseline[f] = await runGitIn(args.projectRoot, ["show", `HEAD:${f}`]);
        } catch {
            baseline[f] = "";
        }
    }
    return baseline;
}
