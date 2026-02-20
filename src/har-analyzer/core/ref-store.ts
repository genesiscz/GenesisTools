import { RefStoreManager as SharedRefStoreManager } from "@app/utils/references";

export type { RefEntry, RefStore } from "@app/utils/references";

export class RefStoreManager extends SharedRefStoreManager {
	get sessionHash(): string {
		return this.sessionId;
	}

	constructor(sessionHash: string) {
		super("har-analyzer", sessionHash);
	}
}
