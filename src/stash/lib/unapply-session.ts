import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { RegionClass } from "./classify";

export type Decision = "update" | "discard" | "skip" | "auto-remove" | null;

export interface SessionRegion {
    id: string;
    filePath: string;
    hunkIndex: number;
    klass: RegionClass;
    decision: Decision;
    storedContent?: string;
    currentContent?: string | null;
}

export interface SessionState {
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    regions: SessionRegion[];
    currentIndex: number;
    startedAt: string;
    pausedAt: string | null;
}

export class UnapplySession {
    private constructor(
        private state: SessionState,
        private readonly stateDir: string
    ) {}

    static start(args: {
        stashId: string;
        stashName: string;
        projectPath: string;
        projectHash: string;
        regions: SessionRegion[];
        stateDir: string;
    }): UnapplySession {
        const state: SessionState = {
            stashId: args.stashId,
            stashName: args.stashName,
            projectPath: args.projectPath,
            projectHash: args.projectHash,
            regions: args.regions.map((r) => ({ ...r })),
            currentIndex: 0,
            startedAt: new Date().toISOString(),
            pausedAt: null,
        };
        const s = new UnapplySession(state, args.stateDir);
        s.advanceToNextUndecided();
        return s;
    }

    static async load(args: {
        stashId: string;
        projectHash: string;
        stateDir: string;
    }): Promise<UnapplySession | null> {
        const path = stateFilePath(args.stateDir, args.projectHash, args.stashId);
        if (!existsSync(path)) {
            return null;
        }
        const raw = await readFile(path, "utf8");
        // SafeJSON.parse returns `any` (matches native JSON.parse). The file shape is fully owned by
        // this module (writePersist below), so the cast is safe; a future migration would key on the
        // `startedAt` field to detect older shapes.
        const state = SafeJSON.parse(raw) as SessionState;
        return new UnapplySession(state, args.stateDir);
    }

    regions(): SessionRegion[] {
        return this.state.regions;
    }

    currentRegion(): SessionRegion | null {
        return this.state.regions[this.state.currentIndex] ?? null;
    }

    isComplete(): boolean {
        return this.state.regions.every((r) => r.decision !== null);
    }

    progress(): { decided: number; total: number } {
        const decided = this.state.regions.filter((r) => r.decision !== null).length;
        return { decided, total: this.state.regions.length };
    }

    decide(decision: Exclude<Decision, null | "auto-remove">): void {
        const region = this.currentRegion();
        if (!region) {
            throw new Error("no current region");
        }
        region.decision = decision;
        this.advanceToNextUndecided();
    }

    private advanceToNextUndecided(): void {
        for (let i = this.state.currentIndex; i < this.state.regions.length; i++) {
            const r = this.state.regions[i];
            if (!r) {
                continue;
            }
            if (r.decision === null) {
                this.state.currentIndex = i;
                return;
            }
        }
        this.state.currentIndex = this.state.regions.length;
    }

    async persist(): Promise<void> {
        this.state.pausedAt = new Date().toISOString();
        const path = stateFilePath(this.stateDir, this.state.projectHash, this.state.stashId);
        await writeFile(path, SafeJSON.stringify(this.state, null, 2));
    }

    async abort(): Promise<void> {
        const path = stateFilePath(this.stateDir, this.state.projectHash, this.state.stashId);
        if (existsSync(path)) {
            await unlink(path);
        }
    }

    async complete(): Promise<void> {
        await this.abort();
    }

    snapshot(): SessionState {
        return this.state;
    }
}

function stateFilePath(stateDir: string, projectHash: string, stashId: string): string {
    return join(stateDir, `${projectHash.slice(0, 12)}--unapply--${stashId.slice(0, 6)}.json`);
}
