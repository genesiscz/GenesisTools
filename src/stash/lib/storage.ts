import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class StashStorage {
    private readonly base: string;

    constructor(base?: string) {
        const envRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
        this.base = base ?? envRoot ?? join(homedir(), ".genesis-tools", "stash");
    }

    root(): string {
        return this.base;
    }

    storeRepoDir(): string {
        return join(this.base, "store");
    }

    dbPath(): string {
        return join(this.base, "index.db");
    }

    stateDir(): string {
        return join(this.base, "state");
    }

    cacheDir(): string {
        return join(this.base, "cache");
    }

    async ensureDirs(): Promise<void> {
        await Promise.all([
            mkdir(this.storeRepoDir(), { recursive: true }),
            mkdir(this.stateDir(), { recursive: true }),
            mkdir(this.cacheDir(), { recursive: true }),
        ]);
    }
}
