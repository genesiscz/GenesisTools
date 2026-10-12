import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * What tells one version of a file from the next without reading it. Any write moves the ctime, and a file
 * replaced by another gets a new inode, so a value is never served for content it was not computed from.
 */
export interface FileIdentity {
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

/** The identity of `path`, or null when it cannot be stat'ed (the caller then reads the file and reports why). */
export async function fileIdentity(path: string): Promise<FileIdentity | null> {
    try {
        const status = await stat(path);
        return { ino: status.ino, size: status.size, mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs };
    } catch (err) {
        logger.debug({ err, path }, "[identity-cache] file not stat'ed");
        return null;
    }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return (
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs
    );
}

function isIdentity(value: Record<string, unknown>): boolean {
    return (
        typeof value.ino === "number" &&
        typeof value.size === "number" &&
        typeof value.mtimeMs === "number" &&
        typeof value.ctimeMs === "number"
    );
}

export interface FileIdentityCacheOptions<T> {
    /**
     * Entries kept; the least recently used goes first. Must exceed the files one pass touches: a pass over more
     * files than the limit evicts each entry just before it is needed and never hits (the Claude tail cache held
     * 2,000 entries for 2,404 transcripts, 0 hits per listing, 2026-10-12). Evicting an entry used in this process
     * logs a warning for that reason.
     */
    limit: number;
    /**
     * Also keep the cache in a file, so a new process re-reads only the files that changed since another process
     * read them. Bump `version` whenever the meaning of a value changes: a file of another version is ignored.
     */
    persist?: {
        path: () => string;
        version: number;
        /** Checks a value read back from the file; an entry that fails it is dropped. */
        isValue: (value: unknown) => value is T;
    };
}

/**
 * Values computed from a file's contents (a parsed header, a summary, the usage at a transcript's tail), each kept
 * with the identity of the file it came from and served only while the file still has that identity. So the cache
 * skips the read and the parse of a file that did not change, and can never answer older than the file is: the
 * identity is taken fresh by the caller on every use.
 *
 * Take the identity BEFORE reading the file: a write during the read then leaves a newer identity, and the next
 * use reads the file again.
 */
export class FileIdentityCache<T> {
    private readonly entries = new Map<string, { identity: FileIdentity; value: T }>();
    /** Keys read or written by this process: evicting one of them means the limit is below one pass. */
    private readonly used = new Set<string>();
    private loaded: Promise<void> | undefined;
    private dirty = false;
    private warnedSmall = false;

    constructor(private readonly options: FileIdentityCacheOptions<T>) {}

    /** The value kept for `path`, when `identity` (taken just now) matches the identity it was computed for. */
    get(path: string, identity: FileIdentity | null): T | undefined {
        const entry = this.entries.get(path);

        if (!identity || !entry || !sameIdentity(entry.identity, identity)) {
            return undefined;
        }

        // Most recent last, so the entries no pass touches (deleted files) are the first to go. Not a change worth
        // saving by itself.
        this.entries.delete(path);
        this.entries.set(path, entry);
        this.used.add(path);
        return entry.value;
    }

    set(path: string, identity: FileIdentity, value: T): void {
        this.entries.delete(path);
        this.entries.set(path, { identity, value });
        this.used.add(path);
        this.dirty = true;

        if (this.entries.size > this.options.limit) {
            const oldest = this.entries.keys().next().value;

            if (oldest !== undefined) {
                this.entries.delete(oldest);
                this.warnIfTooSmall(oldest);
            }
        }
    }

    private warnIfTooSmall(evicted: string): void {
        if (this.warnedSmall || !this.used.has(evicted)) {
            return;
        }

        this.warnedSmall = true;
        logger.warn(
            { limit: this.options.limit, file: this.options.persist?.path() },
            "[identity-cache] evicted an entry this process used: the limit is smaller than one pass, so it will miss"
        );
    }

    delete(path: string): void {
        this.dirty = this.entries.delete(path) || this.dirty;
    }

    /** Reads the saved file once per process, under the entries this process already holds. */
    load(): Promise<void> {
        const persist = this.options.persist;

        if (!persist) {
            return Promise.resolve();
        }

        this.loaded ??= (async () => {
            const path = persist.path();

            try {
                const file = Bun.file(path);

                if (!(await file.exists())) {
                    return;
                }

                const saved: unknown = SafeJSON.parse(await file.text(), { strict: true });

                if (!isObject(saved) || saved.version !== persist.version || !isObject(saved.entries)) {
                    logger.debug({ path }, "[identity-cache] another version on disk; starting empty");
                    return;
                }

                for (const [key, entry] of Object.entries(saved.entries)) {
                    if (
                        this.entries.has(key) ||
                        !isObject(entry) ||
                        !isObject(entry.identity) ||
                        !isIdentity(entry.identity) ||
                        !persist.isValue(entry.value)
                    ) {
                        continue;
                    }

                    const identity = entry.identity;
                    this.entries.set(key, {
                        identity: {
                            ino: Number(identity.ino),
                            size: Number(identity.size),
                            mtimeMs: Number(identity.mtimeMs),
                            ctimeMs: Number(identity.ctimeMs),
                        },
                        value: entry.value,
                    });
                }
            } catch (err) {
                logger.debug({ err, path }, "[identity-cache] saved cache unreadable; starting empty");
            }
        })();
        return this.loaded;
    }

    /** Writes the file when an entry changed: a temporary file renamed into place, so a reader never sees half. */
    async save(): Promise<void> {
        const persist = this.options.persist;

        if (!persist || !this.dirty) {
            return;
        }

        this.dirty = false;
        const path = persist.path();
        const writing = `${path}.${process.pid}.tmp`;

        try {
            await mkdir(dirname(path), { recursive: true });
            await Bun.write(
                writing,
                SafeJSON.stringify(
                    { version: persist.version, entries: Object.fromEntries(this.entries) },
                    { strict: true }
                )
            );
            await rename(writing, path);
        } catch (err) {
            logger.debug({ err, path }, "[identity-cache] cache not saved");
        }
    }

    /** Forgets everything, including that the file was read: the next `load` reads it again. For tests. */
    forget(): void {
        this.entries.clear();
        this.used.clear();
        this.warnedSmall = false;
        this.loaded = undefined;
        this.dirty = false;
    }
}
