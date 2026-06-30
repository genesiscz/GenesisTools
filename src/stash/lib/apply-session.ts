import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

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

    async persist(): Promise<void> {
        const file = this.stateFile();
        await writeFile(file, SafeJSON.stringify(this.snap, undefined, 2));
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
