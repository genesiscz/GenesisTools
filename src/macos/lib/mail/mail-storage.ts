import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage } from "@app/macos/lib/mail/types";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import { SeenStore } from "./seen-store";

const SEARCH_RESULTS_FILE = "macos-mail-last-search.json";

/**
 * Centralised storage facade for the mail tool.
 * Wraps Storage + SeenStore + temp-file persistence so commands
 * never need to know about paths or DB wiring.
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

    /** Serialise search results to a temp file so `download` can pick them up. */
    saveSearchResults(messages: MailMessage[]): string {
        const serialized = SafeJSON.stringify(
            messages.map((m) => ({
                ...m,
                dateSent: m.dateSent.toISOString(),
                dateReceived: m.dateReceived.toISOString(),
            }))
        );
        const path = join(tmpdir(), SEARCH_RESULTS_FILE);
        writeFileSync(path, serialized);
        return path;
    }

    /** Load previously-saved search results (or null if none exist). */
    loadSearchResults(): MailMessage[] | null {
        const path = join(tmpdir(), SEARCH_RESULTS_FILE);

        if (!existsSync(path)) {
            return null;
        }

        try {
            const raw = readFileSync(path, "utf-8");
            const parsed = SafeJSON.parse(raw, { strict: true }) as Array<Record<string, unknown>>;
            return parsed.map((m) => ({
                ...m,
                dateSent: new Date(m.dateSent as string),
                dateReceived: new Date(m.dateReceived as string),
            })) as MailMessage[];
        } catch {
            return null;
        }
    }
}
