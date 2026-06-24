import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { classifyRegion } from "../lib/classify";
import { applyDecisionToCode } from "../lib/decisions";
import { renderDiff } from "../lib/diff-render";
import { newStashId } from "../lib/ids";
import { parseMarkers } from "../lib/markers";
import { detectProject } from "../lib/projects";
import { extractRegionContent } from "../lib/regions";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import { type Decision, type SessionRegion, UnapplySession } from "../lib/unapply-session";
import type { ApplicationRow, StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:unapply");

export interface UnapplyOptions {
    name: string;
    action: "start" | "continue" | "skip" | "abort" | "status";
    decision:
        | Exclude<Decision, null | "auto-remove">
        | "discard-all-dangerous"
        | "update-stash-all-dangerous"
        | undefined;
}

export async function unapplyCommand(opts: UnapplyOptions): Promise<void> {
    log.debug({ opts }, "unapplyCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }

    const projectHash = createHash("sha256").update(project.rootPath).digest("hex");

    if (opts.action === "abort") {
        const s = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!s) {
            ui.warn("no in-progress unapply session");
            return;
        }
        await s.abort();
        ui.ok("aborted");
        return;
    }

    if (opts.action === "status") {
        const s = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!s) {
            ui.info("no in-progress session");
            return;
        }
        const p = s.progress();
        const cur = s.currentRegion();
        ui.info(`${p.decided}/${p.total} decided; current: ${cur?.filePath ?? "(none)"} hunk ${cur?.hunkIndex ?? "?"}`);
        return;
    }

    let session = await UnapplySession.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
    let bootstrapped = false;
    if (!session) {
        if (opts.action !== "start") {
            ui.err("no in-progress session; run without --continue to start");
            db.close();
            process.exit(1);
        }
        session = await bootstrapSession({ storage, db, stash, project, projectHash });
        bootstrapped = true;
        log.debug(
            {
                regionsTotal: session.regions().length,
                autoRemove: session.regions().filter((r) => r.decision === "auto-remove").length,
            },
            "session bootstrapped"
        );
    }

    // Only strip the trivially-unchanged regions on the FIRST run of this session.
    // On --continue we'd otherwise re-process every prior auto-remove with no markers left to remove
    // (idempotent but noisy; the guard keeps logs clean).
    if (bootstrapped) {
        await processAutoRemoves({ session, projectRoot: project.rootPath });
    }

    if (opts.decision === "discard-all-dangerous" || opts.decision === "update-stash-all-dangerous") {
        const blanket = opts.decision === "discard-all-dangerous" ? "discard" : "update";
        const undecided = session.regions().filter((r) => r.decision === null).length;
        ui.warn(`blanket decision: ${blanket} (applies to ${undecided} undecided region${undecided === 1 ? "" : "s"})`);
        log.debug({ blanket, undecided }, "blanket dangerous-decision applied");
        for (const r of session.regions()) {
            if (r.decision === null) {
                r.decision = blanket;
            }
        }
    } else if (opts.decision) {
        if (session.currentRegion()) {
            log.debug(
                { region: session.currentRegion()?.filePath, decision: opts.decision },
                "per-step decision recorded"
            );
            session.decide(opts.decision);
        }
    } else if (opts.action === "skip") {
        if (session.currentRegion()) {
            log.debug({ region: session.currentRegion()?.filePath, decision: "skip" }, "--skip recorded");
            session.decide("skip");
        }
    }

    if (isInteractive() && !session.isComplete()) {
        await walkInteractive({ session, projectRoot: project.rootPath });
    }

    if (!session.isComplete()) {
        await session.persist();
        await emitNonTtyPrompt({ session });
        db.close();
        return;
    }

    const stats = await executeAllDecisions({ session, projectRoot: project.rootPath, storage, db, stash });

    const now = new Date().toISOString();
    db.run(
        "UPDATE applications SET state = 'unapplied', unapplied_at = ? WHERE stash_id = ? AND project_path = ? AND state = 'active'",
        [now, stash.id, project.rootPath]
    );

    await session.complete();

    ui.ok(
        `unapplied "${opts.name}" — ${stats.removed} removed, ${stats.updated} captured to v${stats.newVersion ?? "(none)"}, ${stats.skipped} skipped`
    );

    db.close();
    log.debug({ stashId: stash.id, stats }, "stash unapplied");
}

async function bootstrapSession(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    project: NonNullable<Awaited<ReturnType<typeof detectProject>>>;
    projectHash: string;
}): Promise<UnapplySession> {
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(args.stash.id, args.project.rootPath);
    if (!app) {
        ui.err(`"${args.stash.name}" is not applied here`);
        process.exit(1);
    }
    const version = args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);
    if (!version) {
        ui.err("version row missing");
        process.exit(1);
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regionMap = collectRegionsFromPatch(storedPatch);

    const sessionRegions: SessionRegion[] = [];
    for (const r of regionMap) {
        const fileContent = await readFile(join(args.project.rootPath, r.filePath), "utf8").catch(() => null);
        const present = fileContent ? parseMarkers(fileContent).some((m) => m.name === args.stash.name) : false;
        const currentContent = fileContent
            ? await extractRegionContent(join(args.project.rootPath, r.filePath), args.stash.name)
            : null;
        const klass = classifyRegion({
            storedContent: r.content,
            currentContent,
            present,
        }).klass;
        sessionRegions.push({
            id: newStashId(),
            filePath: r.filePath,
            hunkIndex: r.hunkIndex,
            klass,
            decision: klass === "unchanged" ? "auto-remove" : null,
            storedContent: r.content,
            currentContent,
        });
    }

    return UnapplySession.start({
        stashId: args.stash.id,
        stashName: args.stash.name,
        projectPath: args.project.rootPath,
        projectHash: args.projectHash,
        regions: sessionRegions,
        stateDir: args.storage.stateDir(),
    });
}

interface PatchRegion {
    filePath: string;
    hunkIndex: number;
    content: string;
}

function collectRegionsFromPatch(patch: string): PatchRegion[] {
    const regions: PatchRegion[] = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let hunkIndex = 0;
    let buffer: string[] = [];
    const flush = () => {
        if (currentFile && buffer.length) {
            hunkIndex++;
            regions.push({ filePath: currentFile, hunkIndex, content: buffer.join("\n") });
            buffer = [];
        }
    };
    for (const line of lines) {
        // Post-image file header from `git diff --dst-prefix=b/` — captures relative path; resets hunk index per file.
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) {
            flush();
            currentFile = fm[1] ?? null;
            hunkIndex = 0;
            continue;
        }
        // New hunk delimiter `@@ ... @@` — flush the previous hunk's accumulated additions.
        if (line.startsWith("@@")) {
            flush();
            continue;
        }
        // Added (`+`) lines accumulate into the current region buffer (stripping the `+` prefix); context/removal lines terminate it.
        if (line.startsWith("+") && !line.startsWith("+++")) {
            buffer.push(line.slice(1));
        } else if (buffer.length && (line.startsWith(" ") || line.startsWith("-"))) {
            flush();
        }
    }
    flush();
    return regions;
}

async function processAutoRemoves(args: { session: UnapplySession; projectRoot: string }): Promise<void> {
    for (const r of args.session.regions()) {
        if (r.decision === "auto-remove") {
            await applyDecisionToCode({
                filePath: join(args.projectRoot, r.filePath),
                regionName: args.session.snapshot().stashName,
                decision: "auto-remove",
            });
        }
    }
}

async function walkInteractive(args: { session: UnapplySession; projectRoot: string }): Promise<void> {
    const { select, note } = await import("@clack/prompts");
    while (!args.session.isComplete()) {
        const region = args.session.currentRegion();
        if (!region) {
            return;
        }
        const total = args.session.regions().length;
        const idx = args.session.snapshot().currentIndex + 1;
        const diff = renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        });
        note(diff, `Region ${idx}/${total} — class: ${region.klass}`);
        const selectOpts: Array<{ value: Exclude<Decision, null | "auto-remove">; label: string; hint?: string }> = [
            { value: "update", label: "update — capture current as new vN+1, remove from code" },
            { value: "discard", label: "discard — remove using stored content (lose local edits)" },
            { value: "skip", label: "skip — leave code & store alone (warns)" },
        ];
        if (region.klass === "missing") {
            selectOpts.splice(1, 1);
        }
        const sel = await select({ message: "decision?", options: selectOpts });
        if (typeof sel !== "string") {
            ui.warn("paused; resume with: tools stash unapply <name> --continue");
            await args.session.persist();
            process.exit(0);
        }
        args.session.decide(sel as Exclude<Decision, null | "auto-remove">);
    }
}

async function emitNonTtyPrompt(args: { session: UnapplySession }): Promise<void> {
    const region = args.session.currentRegion();
    if (!region) {
        return;
    }
    const total = args.session.regions().length;
    const idx = args.session.snapshot().currentIndex + 1;
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
    for (const dec of ["update", "discard", "skip"]) {
        // suggestCommand pulls <name> from process.argv; subcommand=["unapply"] strips the duplicate token.
        process.stderr.write(
            `  ${suggestCommand("tools stash unapply", { add: ["--continue", `--decision=${dec}`], subcommand: ["unapply"] })}\n`
        );
    }
    process.stderr.write(
        `Or abort:\n  ${suggestCommand("tools stash unapply", { add: ["--abort"], subcommand: ["unapply"] })}\n`
    );
}

interface ExecStats {
    removed: number;
    updated: number;
    skipped: number;
    newVersion: number | null;
}

async function executeAllDecisions(args: {
    session: UnapplySession;
    projectRoot: string;
    storage: StashStorage;
    db: Database;
    stash: StashRow;
}): Promise<ExecStats> {
    const stats: ExecStats = { removed: 0, updated: 0, skipped: 0, newVersion: null };
    const updatedRegions: SessionRegion[] = [];
    for (const r of args.session.regions()) {
        if (r.decision === "skip") {
            stats.skipped++;
            ui.warn(`region ${r.filePath} hunk ${r.hunkIndex}: kept (stash and code now diverged)`);
            continue;
        }
        if (r.decision === "update") {
            updatedRegions.push(r);
            stats.updated++;
        }
        await applyDecisionToCode({
            filePath: join(args.projectRoot, r.filePath),
            regionName: args.session.snapshot().stashName,
            decision: r.decision ?? "auto-remove",
        });
        if (r.decision === "auto-remove" || r.decision === "discard" || r.decision === "update") {
            stats.removed++;
        }
    }
    if (updatedRegions.length) {
        stats.newVersion = await capturedUpdatesAsNewVersion({
            storage: args.storage,
            db: args.db,
            stash: args.stash,
            updatedRegions,
        });
    }
    return stats;
}

/**
 * Persist the user's `update` decisions as a new stash version.
 *
 * Builds a real unified diff per region (stored content → current content), reusing the existing
 * v(N) baseline ref so future `apply` calls of v(N+1) still have a 3-way base. The diff is a plain
 * concatenation of per-region `--- a/<path> / +++ b/<path>` blocks — git apply parses this and
 * the round-trip test in e2e.test.ts proves it applies cleanly.
 */
async function capturedUpdatesAsNewVersion(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    updatedRegions: SessionRegion[];
}): Promise<number> {
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const maxV = args.db
        .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
        .get(args.stash.id);
    const newV = (maxV?.m ?? 0) + 1;

    const patchParts: string[] = [];
    for (const r of args.updatedRegions) {
        const before = r.storedContent ?? "";
        const after = r.currentContent ?? "";
        patchParts.push(buildUnifiedDiff({ path: r.filePath, before, after }));
    }
    const patch = patchParts.join("");

    const patchRef = `refs/stashes/${args.stash.id}/v${newV}`;
    const baselineRef = `refs/baselines/${args.stash.id}/v${newV}`;

    // Carry the prior baseline forward: an updated version still merges against the original
    // pre-stash files, so 3-way merge stays valid for any future apply target.
    const baselineFiles: Record<string, string> = {};
    for (const r of args.updatedRegions) {
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
    log.debug({ patchRef, baselineRef, regions: args.updatedRegions.length }, "captured-from-unapply version written");

    const now = new Date().toISOString();
    args.db.run(
        `INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{"capturedFromUnapply":true}', ?)`,
        [
            newStashId(),
            args.stash.id,
            newV,
            patchRef,
            args.updatedRegions.length,
            new Set(args.updatedRegions.map((r) => r.filePath)).size,
            now,
        ]
    );
    args.db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, args.stash.id]);
    return newV;
}

/** Minimal single-file unified diff between `before` and `after` content. */
function buildUnifiedDiff(args: { path: string; before: string; after: string }): string {
    const beforeLines = args.before.split("\n");
    const afterLines = args.after.split("\n");
    const header = [
        `--- a/${args.path}`,
        `+++ b/${args.path}`,
        // Whole-file replace hunk: covers `before` (count=beforeLines.length) → `after` (count=afterLines.length).
        // Sufficient for the captured-region case where boundaries are exact.
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ].join("\n");
    const body = [...beforeLines.map((l) => `-${l}`), ...afterLines.map((l) => `+${l}`)].join("\n");
    return `${header}\n${body}\n`;
}
