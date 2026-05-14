import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";
import { SeenStore } from "./seen-store";

/**
 * Centralised storage facade for the mail tool.
 */
export class MailStorage {
    private storage: Storage;

    constructor() {
        this.storage = new Storage("macos-mail");
    }

    /** Open the seen-messages database. Caller must call `.close()` when done. */
    openSeenStore(): SeenStore {
        const dbPath = join(this.storage.getBaseDir(), "seen.db");
        return new SeenStore(dbPath);
    }
}
