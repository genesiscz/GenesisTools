import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

const { log } = logger.scoped("stash:walk");

export type Verb = "update" | "unapply";
export type Decision = "capture" | "restore" | "skip" | "auto-capture" | null;
export type RegionClass = "unchanged" | "edited" | "missing" | "new-extra";

export interface WalkRegion {
    id: string;
    filePath: string;
    hunkIndex: number;
    /** Author region name from `// #region @stash:<name>` inside the patch, or null for anonymous hunks. */
    name: string | null;
    klass: RegionClass;
    /** null = not yet decided. `auto-capture` is reserved for unchanged regions (no prompt). */
    decision: Decision;
    storedContent: string | null;
    currentContent: string | null;
}

export interface WalkSnapshot {
    verb: Verb;
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    startedAt: string;
    regions: WalkRegion[];
    currentIndex: number;
    pausedAt: string | null;
    /** Verb-specific data. Update: `{ currentVersionId, targetVNext }`. Unapply: `{}`. */
    extension: Record<string, unknown>;
}

export interface StartArgs {
    verb: Verb;
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    regions: WalkRegion[];
    stateDir: string;
    extension: Record<string, unknown>;
}

export class Walk {
    constructor(
        private snap: WalkSnapshot,
        private stateDir: string
    ) {
        this.skipDecided();
    }

    static async start(args: StartArgs): Promise<Walk> {
        await mkdir(args.stateDir, { recursive: true });
        const snap: WalkSnapshot = {
            verb: args.verb,
            stashId: args.stashId,
            stashName: args.stashName,
            projectPath: args.projectPath,
            projectHash: args.projectHash,
            startedAt: new Date().toISOString(),
            regions: args.regions,
            currentIndex: 0,
            pausedAt: null,
            extension: args.extension,
        };
        const walk = new Walk(snap, args.stateDir);
        log.debug({ verb: args.verb, stashId: args.stashId, regions: args.regions.length }, "walk started");
        return walk;
    }

    static async load(args: { stashId: string; projectHash: string; stateDir: string }): Promise<Walk | null> {
        // Walk file naming convention: <projectHash>--<verb>--<stashId>.json. The verb is in the
        // filename so a directory listing tells you what kind of in-progress session each file is.
        // For back-compat, v1 unapply state files have no `verb` field in the JSON — we derive it
        // from the filename and migrate on first load.
        for (const verb of ["update", "unapply"] as const) {
            const file = join(args.stateDir, `${args.projectHash}--${verb}--${args.stashId}.json`);
            try {
                const raw = await readFile(file, "utf8");
                const parsed = SafeJSON.parse(raw) as Partial<WalkSnapshot>;
                const snap: WalkSnapshot = {
                    verb: parsed.verb ?? verb,
                    stashId: parsed.stashId ?? args.stashId,
                    stashName: parsed.stashName ?? "",
                    projectPath: parsed.projectPath ?? "",
                    projectHash: parsed.projectHash ?? args.projectHash,
                    startedAt: parsed.startedAt ?? new Date().toISOString(),
                    regions: parsed.regions ?? [],
                    currentIndex: parsed.currentIndex ?? 0,
                    pausedAt: parsed.pausedAt ?? null,
                    extension: parsed.extension ?? {},
                };
                return new Walk(snap, args.stateDir);
            } catch (err) {
                // ENOENT = no session for this verb. Other errors bubble up so corruption surfaces.
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    log.warn({ err, file }, "walk state file unreadable");
                }
            }
        }
        return null;
    }

    currentRegion(): WalkRegion | null {
        return this.snap.regions[this.snap.currentIndex] ?? null;
    }

    regions(): WalkRegion[] {
        return this.snap.regions;
    }

    snapshot(): WalkSnapshot {
        return this.snap;
    }

    progress(): { decided: number; total: number } {
        const decided = this.snap.regions.filter((r) => r.decision !== null).length;
        return { decided, total: this.snap.regions.length };
    }

    decide(d: Exclude<Decision, null | "auto-capture">): void {
        const region = this.currentRegion();
        if (!region) {
            return;
        }
        region.decision = d;
        this.snap.currentIndex++;
        this.skipDecided();
    }

    isComplete(): boolean {
        return this.snap.regions.every((r) => r.decision !== null);
    }

    async persist(): Promise<void> {
        this.snap.pausedAt = new Date().toISOString();
        const file = this.stateFile();
        await writeFile(file, SafeJSON.stringify(this.snap, undefined, 2));
        log.debug({ file, currentIndex: this.snap.currentIndex }, "walk persisted");
    }

    async abort(): Promise<void> {
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
        log.debug({ stashId: this.snap.stashId, verb: this.snap.verb }, "walk aborted");
    }

    async complete(): Promise<void> {
        // Completing is the same disk-level operation as aborting (remove the state file). Logically
        // distinct so logs distinguish the two. Tests can grep for which one happened.
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
        log.debug({ stashId: this.snap.stashId, verb: this.snap.verb }, "walk completed");
    }

    private skipDecided(): void {
        while (
            this.snap.currentIndex < this.snap.regions.length &&
            this.snap.regions[this.snap.currentIndex]?.decision !== null
        ) {
            this.snap.currentIndex++;
        }
    }

    private stateFile(): string {
        return join(this.stateDir, `${this.snap.projectHash}--${this.snap.verb}--${this.snap.stashId}.json`);
    }
}
