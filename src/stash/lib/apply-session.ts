import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type ApplyRecoverySnapshot, captureApplySnapshot, restoreApplySnapshot } from "./apply-recovery";

const { log } = logger.scoped("stash:apply-session");

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
        await mkdir(args.stateDir, { recursive: true });
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

    async captureResult(conflictedFiles: string[]): Promise<void> {
        this.snap.conflictedFiles = conflictedFiles;
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
        await writeFile(file, SafeJSON.stringify(this.snap, undefined, 2));
    }

    async archiveApplication(restorePatch: string): Promise<void> {
        this.snap.restorePatch = restorePatch;
        await writeFile(
            join(this.stateDir, `${this.snap.projectHash}--applied--${this.snap.stashId}.json`),
            SafeJSON.stringify(this.snap)
        );
        await this.complete();
    }

    static async applicationPatch(args: {
        stashId: string;
        projectHash: string;
        versionId: string;
        stateDir: string;
    }): Promise<string | null> {
        try {
            const raw = await readFile(
                join(args.stateDir, `${args.projectHash}--applied--${args.stashId}.json`),
                "utf8"
            );
            const snap = SafeJSON.parse(raw) as ApplySessionSnapshot;
            return snap.versionId === args.versionId ? (snap.restorePatch ?? null) : null;
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
