import { Storage } from "@app/utils/storage/storage";
import type { ApoptosisState } from "./types";

const STATE_FILE = "state.json";
const STATE_TTL = "3650 days";

/** Persists per-scan-dir death marks under ~/.genesis-tools/apoptosis/cache/state.json. */
export class ApoptosisStateStore {
    private storage = new Storage("apoptosis");

    async getMarks(dir: string): Promise<Record<string, { firstMarked: string }>> {
        const state = await this.storage.getCacheFile<ApoptosisState>(STATE_FILE, STATE_TTL);
        return state?.[dir] ?? {};
    }

    async setMarks(dir: string, marks: Record<string, { firstMarked: string }>): Promise<void> {
        await this.storage.atomicUpdate<ApoptosisState>(STATE_FILE, (current) => {
            const next: ApoptosisState = current ?? {};
            next[dir] = marks;
            return next;
        });
    }

    async mark(dir: string, file: string, firstMarked: string): Promise<void> {
        await this.storage.atomicUpdate<ApoptosisState>(STATE_FILE, (current) => {
            const next: ApoptosisState = current ?? {};
            const dirMarks = next[dir] ?? {};
            dirMarks[file] = { firstMarked };
            next[dir] = dirMarks;
            return next;
        });
    }

    async clear(dir: string, file: string): Promise<void> {
        await this.storage.atomicUpdate<ApoptosisState>(STATE_FILE, (current) => {
            const next: ApoptosisState = current ?? {};
            if (next[dir]) {
                delete next[dir][file];
            }

            return next;
        });
    }

    async resetAll(): Promise<void> {
        await this.storage.deleteCacheFile(STATE_FILE);
    }
}
