import { RefStoreManager as SharedRefStoreManager } from "@genesiscz/utils/references";

export type { RefEntry, RefStore } from "@genesiscz/utils/references";

export class RefStoreManager extends SharedRefStoreManager {
    get sessionHash(): string {
        return this.sessionId;
    }

    constructor(sessionHash: string) {
        super("har-analyzer", sessionHash);
    }
}
