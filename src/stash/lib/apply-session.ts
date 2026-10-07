import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type ApplyRecoverySnapshot, captureApplySnapshot, restoreApplySnapshot } from "./apply-recovery";

const { log } = logger.scoped("stash:apply-session");

/**
 * Session files hold base64 copies of every affected file and of the Git index, so they get the
 * same protection as a private file: 0600 in a 0700 directory, whatever the umask says.
 */
async function writePrivate(file: string, content: string): Promise<void> {
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600);
}

async function ensurePrivateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
}

/**
 * Where an apply attempt stopped. `conflict` is the only resumable state: `failed` means git
 * rejected the patch but the tree still changed, `applied` means the patch landed and a later
 * step (decoration, the applications row) threw. Both of those can only be aborted.
 */
export type ApplyOutcome = "conflict" | "failed" | "applied";

export interface ApplySessionSnapshot {
    stashId: string;
    stashName: string;
    versionId: string;
    version: number;
    projectPath: string;
    projectHash: string;
    conflictedFiles: string[];
    startedAt: string;
    before?: ApplyRecoverySnapshot;
    after?: ApplyRecoverySnapshot;
    restorePatch?: string;
    /** Changed symlinks and binary files: no hunk can restore them, so unapply must refuse them. */
    unsupportedFiles?: string[];
    outcome?: ApplyOutcome;
}

export interface StartArgs {
    stashId: string;
    stashName: string;
    versionId: string;
    version: number;
    projectPath: string;
    projectHash: string;
    conflictedFiles: string[];
    stateDir: string;
    before?: ApplyRecoverySnapshot;
}

export class ApplySession {
    constructor(
        private snap: ApplySessionSnapshot,
        private stateDir: string
    ) {}

    static async start(args: StartArgs): Promise<ApplySession> {
        await ensurePrivateDir(args.stateDir);
        const snap: ApplySessionSnapshot = {
            stashId: args.stashId,
            stashName: args.stashName,
            versionId: args.versionId,
            version: args.version,
            projectPath: args.projectPath,
            projectHash: args.projectHash,
            conflictedFiles: args.conflictedFiles,
            startedAt: new Date().toISOString(),
            before: args.before,
        };
        const session = new ApplySession(snap, args.stateDir);
        await session.persist();
        return session;
    }

    static async load(args: { stashId: string; projectHash: string; stateDir: string }): Promise<ApplySession | null> {
        const file = join(args.stateDir, `${args.projectHash}--apply--${args.stashId}.json`);
        try {
            const raw = await readFile(file, "utf8");
            const parsed = SafeJSON.parse(raw) as ApplySessionSnapshot;
            return new ApplySession(parsed, args.stateDir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn({ err, file }, "apply session unreadable");
            }
            return null;
        }
    }

    snapshot(): ApplySessionSnapshot {
        return this.snap;
    }

    /**
     * Check whether the conflicted files still contain unresolved git conflict markers.
     * Returns the list of files that still have `<<<<<<<` markers; empty means clean.
     */
    async remainingConflicts(): Promise<string[]> {
        const stillConflicted: string[] = [];
        // Match anchored git conflict markers only — `<<<<<<<` and `>>>>>>>` at start of a line.
        // The plain `=======` separator is intentionally not matched: legitimate dividers in
        // markdown/RST headers or comment banners would otherwise permanently block --resume.
        for (const rel of this.snap.conflictedFiles) {
            const abs = join(this.snap.projectPath, rel);
            try {
                const content = await readFile(abs, "utf8");
                if (/^<{7}( |$)/m.test(content) || /^>{7}( |$)/m.test(content)) {
                    stillConflicted.push(rel);
                }
            } catch (err) {
                log.debug({ err, rel }, "conflicted file unreadable; treating as resolved");
            }
        }
        return stillConflicted;
    }

    async captureResult(conflictedFiles: string[], outcome: ApplyOutcome): Promise<void> {
        this.snap.conflictedFiles = conflictedFiles;
        this.snap.outcome = outcome;
        if (this.snap.before) {
            this.snap.after = await captureApplySnapshot({
                root: this.snap.projectPath,
                files: Object.keys(this.snap.before.files),
            });
        }
        await this.persist();
    }

    async restore(): Promise<void> {
        if (!this.snap.before || !this.snap.after) {
            throw new Error("This apply session has no complete recovery snapshot; preserve it for manual recovery");
        }
        await restoreApplySnapshot({ root: this.snap.projectPath, before: this.snap.before, after: this.snap.after });
    }

    async persist(): Promise<void> {
        const file = this.stateFile();
        await writePrivate(file, SafeJSON.stringify(this.snap, undefined, 2));
    }

    async archiveApplication(args: { restorePatch: string; unsupportedFiles: string[] }): Promise<void> {
        this.snap.restorePatch = args.restorePatch;
        this.snap.unsupportedFiles = args.unsupportedFiles;
        await writePrivate(
            join(this.stateDir, `${this.snap.projectHash}--applied--${this.snap.stashId}.json`),
            SafeJSON.stringify(this.snap)
        );
        await this.complete();
    }

    /**
     * Move the archived application record to a version written by `update`, with the restore
     * patch rebuilt against the original pre-images. Returns false when there is no archive for
     * `fromVersionId` (a legacy application), which leaves unapply on its stored-patch fallback.
     */
    static async rebindApplication(args: {
        stashId: string;
        projectHash: string;
        stateDir: string;
        fromVersionId: string;
        toVersionId: string;
        toVersion: number;
        restorePatch: string;
    }): Promise<boolean> {
        const file = join(args.stateDir, `${args.projectHash}--applied--${args.stashId}.json`);
        let snap: ApplySessionSnapshot;
        try {
            snap = SafeJSON.parse(await readFile(file, "utf8")) as ApplySessionSnapshot;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            return false;
        }
        if (snap.versionId !== args.fromVersionId) {
            log.warn(
                { file, archived: snap.versionId, expected: args.fromVersionId },
                "application archive names another version; not rebinding"
            );
            return false;
        }
        await writePrivate(
            file,
            SafeJSON.stringify({
                ...snap,
                versionId: args.toVersionId,
                version: args.toVersion,
                restorePatch: args.restorePatch,
            })
        );
        return true;
    }

    static async applicationPatch(args: {
        stashId: string;
        projectHash: string;
        versionId: string;
        stateDir: string;
    }): Promise<string | null> {
        return (await ApplySession.applicationRecord(args))?.restorePatch ?? null;
    }

    /** The pre-apply snapshot of the archived application, whatever version it now names. */
    static async archivedBefore(args: {
        stashId: string;
        projectHash: string;
        stateDir: string;
    }): Promise<ApplyRecoverySnapshot | null> {
        try {
            const raw = await readFile(
                join(args.stateDir, `${args.projectHash}--applied--${args.stashId}.json`),
                "utf8"
            );
            return (SafeJSON.parse(raw) as ApplySessionSnapshot).before ?? null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            return null;
        }
    }

    /** The archived application of `versionId`, or null for none (or one recorded for another version). */
    static async applicationRecord(args: {
        stashId: string;
        projectHash: string;
        versionId: string;
        stateDir: string;
    }): Promise<{ restorePatch: string | null; unsupportedFiles: string[] } | null> {
        try {
            const raw = await readFile(
                join(args.stateDir, `${args.projectHash}--applied--${args.stashId}.json`),
                "utf8"
            );
            const snap = SafeJSON.parse(raw) as ApplySessionSnapshot;
            if (snap.versionId !== args.versionId) {
                return null;
            }
            return { restorePatch: snap.restorePatch ?? null, unsupportedFiles: snap.unsupportedFiles ?? [] };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            return null;
        }
    }

    async complete(): Promise<void> {
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
    }

    async abort(): Promise<void> {
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
    }

    private stateFile(): string {
        return join(this.stateDir, `${this.snap.projectHash}--apply--${this.snap.stashId}.json`);
    }
}
