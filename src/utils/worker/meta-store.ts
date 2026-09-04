import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeSync,
} from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const META_SUFFIX = ".meta.json";

export interface WorkerMetaStoreOptions<T extends { name: string }> {
    /** Directory holding the `<name>.meta.json` files. */
    dir: () => string;
    metaPath: (name: string) => string;
    /** The first field that would make a resume unsafe or impossible, or null. */
    firstInvalidField: (meta: Partial<T> | null | undefined) => string | null;
    /** Lower-case wording for log lines, e.g. "claude worker" / "grok session". */
    label: string;
    /** Capitalised wording for user-facing errors, e.g. "Grok session". */
    title: string;
    /** Message for a name that is already claimed. */
    existsMessage: (name: string) => string;
    log: Logger;
    /** Set when the files are private to this user; omitted keeps the umask default. */
    dirMode?: number;
    fileMode?: number;
}

/**
 * Name-keyed `<name>.meta.json` store for a worker backend.
 *
 * The claude worker store and the grok session store were the same class
 * twice over, down to the O_EXCL claim and the zero-byte cleanup on a failed
 * write; only the validation fields, the wording and the file modes differ,
 * and those are the options above.
 */
export class WorkerMetaStore<T extends { name: string }> {
    constructor(private readonly options: WorkerMetaStoreOptions<T>) {}

    /**
     * The mode is re-applied on every call, so a directory created before the
     * mode was introduced is tightened too.
     */
    ensureDir(): string {
        const path = this.options.dir();
        mkdirSync(path, { recursive: true, ...(this.options.dirMode ? { mode: this.options.dirMode } : {}) });

        if (this.options.dirMode) {
            chmodSync(path, this.options.dirMode);
        }

        return path;
    }

    readMeta(name: string): T | null {
        const { log, label, metaPath, firstInvalidField } = this.options;
        const path = metaPath(name);

        if (!existsSync(path)) {
            return null;
        }

        try {
            const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Partial<T>;
            const invalid = firstInvalidField(parsed);

            if (invalid) {
                log.warn({ path, name, field: invalid }, `${label} metadata cannot be safely resumed; ignoring it`);
                return null;
            }

            return parsed as T;
        } catch (err) {
            log.warn({ err, path, name }, `failed to read ${label} metadata`);
            return null;
        }
    }

    writeMeta(meta: T): void {
        this.ensureDir();
        atomicWriteFileSync(
            this.options.metaPath(meta.name),
            SafeJSON.stringify(meta, null, 2),
            this.options.fileMode ? { mode: this.options.fileMode } : undefined
        );
    }

    /**
     * Claim a name, or fail. O_EXCL makes the check and the write one syscall: a
     * read-then-write pair lets two concurrent starts both see "free", both run
     * turn 1, and the second overwrite the first's record.
     */
    createMeta(meta: T): void {
        this.ensureDir();
        const path = this.options.metaPath(meta.name);
        let fd: number;

        try {
            fd = this.options.fileMode ? openSync(path, "wx", this.options.fileMode) : openSync(path, "wx");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error(this.options.existsMessage(meta.name));
            }

            throw err;
        }

        try {
            writeSync(fd, SafeJSON.stringify(meta, null, 2));
        } catch (err) {
            // The O_EXCL open already claimed the name. Leaving a zero-byte file
            // behind makes that claim permanent: every later start gets EEXIST
            // and every readMeta gets unparseable JSON, so the name is dead
            // until someone deletes it by hand (PR #330 review t13).
            closeSync(fd);
            rmSync(path, { force: true });
            throw err;
        }

        closeSync(fd);
    }

    updateMeta(name: string, update: Partial<T>): T {
        const current = this.readMeta(name);

        if (!current) {
            throw new Error(`${this.options.title} not found: ${name}`);
        }

        const next = { ...current, ...update };
        this.writeMeta(next);

        return next;
    }

    /** Reads, never creates: listing is a diagnostic and must not mkdir the store. */
    listNames(): string[] {
        const dir = this.options.dir();

        if (!existsSync(dir)) {
            return [];
        }

        return readdirSync(dir)
            .filter((file) => file.endsWith(META_SUFFIX))
            .map((file) => file.slice(0, -META_SUFFIX.length))
            .sort();
    }
}
