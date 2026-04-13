import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";

export interface ContactInfo {
    firstName: string | null;
    lastName: string | null;
    nickname: string | null;
    organization: string | null;
    phoneNumbers: string[];
    emails: string[];
}

const ADDRESS_BOOK_DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const SOURCES_DIR = join(ADDRESS_BOOK_DIR, "Sources");
const DB_FILENAME = "AddressBook-v22.abcddb";

/**
 * Reads macOS Contacts (AddressBook) databases to resolve
 * phone numbers and emails to contact display names.
 *
 * Scans all source databases under ~/Library/Application Support/AddressBook/Sources/.
 */
export class MacContactsDatabase {
    private databases: Database[] = [];
    private initialized = false;
    private cache = new Map<string, string | null>();

    constructor() {
        process.on("exit", () => this.close());
    }

    /** Open all AddressBook source databases. */
    private init(): void {
        if (this.initialized) {
            return;
        }

        this.initialized = true;

        if (!existsSync(SOURCES_DIR)) {
            logger.debug("AddressBook Sources directory not found");
            return;
        }

        const sourceIds = readdirSync(SOURCES_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

        for (const sourceId of sourceIds) {
            const dbPath = join(SOURCES_DIR, sourceId, DB_FILENAME);

            if (!existsSync(dbPath)) {
                continue;
            }

            try {
                const db = new Database(dbPath, { readonly: true });
                this.databases.push(db);
            } catch (err) {
                logger.debug(`Failed to open AddressBook source ${sourceId}: ${err}`);
            }
        }

        logger.debug(`Opened ${this.databases.length} AddressBook source databases`);
    }

    close(): void {
        for (const db of this.databases) {
            db.close();
        }

        this.databases = [];
        this.initialized = false;
        this.cache.clear();
    }

    /**
     * Resolve a phone number or email to a display name.
     * Returns the best available name: nickname > "First Last" > organization > null.
     */
    resolveIdentifier(identifier: string): string | null {
        const cached = this.cache.get(identifier);

        if (cached !== undefined) {
            return cached;
        }

        this.init();

        // Normalize: strip spaces, dashes, parens for phone matching
        const normalized = identifier.replace(/[\s\-()]/g, "");
        const isEmail = identifier.includes("@");

        for (const db of this.databases) {
            try {
                const row = isEmail
                    ? (db
                          .prepare(
                              `SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION
                               FROM ZABCDRECORD r
                               JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
                               WHERE e.ZADDRESS = $id OR e.ZADDRESSNORMALIZED = $normalized
                               LIMIT 1`
                          )
                          .get({ $id: identifier, $normalized: normalized }) as ContactRow | null)
                    : (db
                          .prepare(
                              `SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION
                               FROM ZABCDRECORD r
                               JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
                               WHERE REPLACE(REPLACE(REPLACE(REPLACE(p.ZFULLNUMBER, ' ', ''), '-', ''), '(', ''), ')', '') = $normalized
                               LIMIT 1`
                          )
                          .get({ $normalized: normalized }) as ContactRow | null);

                if (row) {
                    const name = buildDisplayName(row);
                    this.cache.set(identifier, name);
                    return name;
                }
            } catch {
                // DB may be WAL-locked by Contacts.app — skip this source
            }
        }

        this.cache.set(identifier, null);
        return null;
    }

    /**
     * Bulk-resolve multiple identifiers. Returns a Map of identifier → display name.
     * Identifiers with no match are omitted from the map.
     */
    resolveAll(identifiers: string[]): Map<string, string> {
        const result = new Map<string, string>();

        for (const id of identifiers) {
            const name = this.resolveIdentifier(id);

            if (name) {
                result.set(id, name);
            }
        }

        return result;
    }
}

interface ContactRow {
    ZFIRSTNAME: string | null;
    ZLASTNAME: string | null;
    ZNICKNAME: string | null;
    ZORGANIZATION: string | null;
}

function buildDisplayName(row: ContactRow): string | null {
    if (row.ZNICKNAME) {
        return row.ZNICKNAME;
    }

    const parts = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean);

    if (parts.length > 0) {
        return parts.join(" ");
    }

    if (row.ZORGANIZATION) {
        return row.ZORGANIZATION;
    }

    return null;
}
