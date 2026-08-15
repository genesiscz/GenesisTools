import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

export class StashStorage {
    private readonly base: string;

    constructor(base?: string) {
        const envRoot = env.getTrimmed("GENESIS_TOOLS_STASH_ROOT");
        this.base = base ?? envRoot ?? join(env.tools.getHome(), ".genesis-tools", "stash");
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
