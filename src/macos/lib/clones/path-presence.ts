import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "clones:path-presence" });

/** One directory's entries. `certain(name)` is true when the entry certainly exists for `existsSync` (a regular
 *  file, a directory or another non-link kind), and false when the name needs a real probe: a symlink (which
 *  `existsSync` follows), an entry of unknown type, or a name the listing lacks. */
export interface DirListing {
    certain(name: string): boolean;
}

/** A listing over a name → certain map. */
export function mapListing(entries: Map<string, boolean>): DirListing {
    return { certain: (name) => entries.get(name) === true };
}

/** Characters JSON writes escaped: a name without them appears verbatim between quotes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are exactly what JSON escapes
const NEEDS_JSON_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** Stored child lists up to this length are searched as text; longer ones are parsed once into a map. */
const STORED_SEARCH_MAX_CHARS = 4096;

/** Lists a directory, or returns null when it cannot be listed (gone, not a directory, no permission). */
export type ListDir = (dir: string) => DirListing | null;

export type ExistsProbe = (path: string) => boolean;

/** A directory's `stat` as the scan records it in `dir_meta` (`walkFiles`: `statSync(dir, { bigint: true })`). */
export interface DirStamp {
    isDirectory: boolean;
    mtimeNs: bigint;
    ino: bigint;
}

/** `"gone"` when the path does not exist (ENOENT), null when the stat failed for another reason. */
export type StatDir = (dir: string) => DirStamp | "gone" | null;

/** What the cache stored for a directory: its stamp and its children at the time of the scan. */
export interface StoredDir {
    mtimeNs: bigint;
    ino: bigint;
    childNamesJson: string;
}

/** Directories whose existence is remembered for the fallback probes. Cleared when it grows past this rather than
 *  allowed to mirror the whole cache. */
const KNOWN_DIRS_LIMIT = 200_000;

/** `dir` is `ancestor` or lies under it. */
function isWithin(dir: string, ancestor: string): boolean {
    if (dir === ancestor) {
        return true;
    }

    return dir.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

function certain(entry: Dirent): boolean {
    if (entry.isSymbolicLink()) {
        return false;
    }

    return (
        entry.isFile() ||
        entry.isDirectory() ||
        entry.isFIFO() ||
        entry.isSocket() ||
        entry.isBlockDevice() ||
        entry.isCharacterDevice()
    );
}

/** `readdirSync` with entry types: the whole directory in one open and a few `getdirentries` calls. */
export function readDirListing(dir: string): DirListing | null {
    try {
        const entries = new Map<string, boolean>();

        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            entries.set(entry.name, certain(entry));
        }

        return mapListing(entries);
    } catch (err) {
        log.debug({ err, dir }, "directory could not be listed; its entries fall back to existsSync");
        return null;
    }
}

/** `statSync` following links, as `existsSync` and the scan both do. */
export function statDirStamp(dir: string): DirStamp | "gone" | null {
    try {
        const st = statSync(dir, { bigint: true, throwIfNoEntry: false });
        if (st === undefined) {
            return "gone";
        }

        return { isDirectory: st.isDirectory(), mtimeNs: st.mtimeNs, ino: st.ino };
    } catch (err) {
        log.debug({ err, dir }, "directory stat failed; its entries fall back to a listing");
        return null;
    }
}

function isStoredChild(value: unknown): value is { name: string; kind: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        typeof value.name === "string" &&
        "kind" in value &&
        typeof value.kind === "string"
    );
}

/** The children the scan stored for a directory, as a listing. A symlink child needs a probe, as in a live listing.
 *
 *  The stored JSON is compact (`[{"name":"a","kind":"dir"},…]`), so a short list is searched as text for the exact
 *  entry, which costs far less than parsing it for the one or two names the sweep asks about. A text form this search
 *  does not recognise only misses, and a miss is probed, so it can never keep or remove the wrong row. */
function storedListing(json: string): DirListing | null {
    if (json.length <= STORED_SEARCH_MAX_CHARS) {
        return {
            certain: (name) => {
                const quoted = NEEDS_JSON_ESCAPE.test(name) ? SafeJSON.stringify(name, { strict: true }) : `"${name}"`;
                const head = `{"name":${quoted},"kind":"`;
                const at = json.indexOf(head);
                if (at < 0) {
                    return false;
                }

                const kind = at + head.length;
                return json.startsWith('file"}', kind) || json.startsWith('dir"}', kind);
            },
        };
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(json, { strict: true });
    } catch (err) {
        log.debug({ err }, "stored child names unreadable; the directory is listed instead");
        return null;
    }

    if (!Array.isArray(parsed)) {
        return null;
    }

    const entries = new Map<string, boolean>();
    for (const child of parsed) {
        if (!isStoredChild(child)) {
            return null;
        }

        entries.set(child.name, child.kind === "file" || child.kind === "dir");
    }

    return mapListing(entries);
}

/**
 * Answers "does this path exist?" as `existsSync` would, for paths visited in sorted order, with about one cheap
 * check per parent directory instead of one `stat` per path.
 *
 * For a parent directory, in order:
 * 1. The scan stored it (`offerStored`) and its `stat` still shows the stored mtime and inode: its children are the
 *    stored ones. This is the scan's own rule (`walkFiles` skips `readdir` on the same match), since only a change of
 *    a directory's entries moves its mtime. One `stat` answers every child.
 * 2. Otherwise one `readdir` of it answers every child.
 *
 * A child is present when that answer names it as a non-link entry. Every other case falls back to the probe the
 * old sweep made (the parent chain from its shallowest unknown ancestor, then the path itself): a name the answer
 * lacks, a symlink, and a parent that cannot be read. So a path is only ever called gone by `existsSync` itself, or
 * because a parent's `stat` found the parent gone.
 *
 * Answers are kept only for the chain of directories above the current path. Sorted paths leave a directory's
 * subtree once and never come back to it, so an answer is never needed again once the walk is outside it.
 */
export class PathPresence {
    /** `existsSync`-style probes issued by the fallback. */
    probes = 0;
    /** Directory listings taken. */
    listings = 0;
    /** Parent directories `stat`ed to compare with their stored stamp. */
    stamps = 0;
    /** Parents whose stored children answered (the stamp still matched). */
    storedHits = 0;

    private readonly exists: ExistsProbe;
    private readonly listDir: ListDir;
    private readonly statDir: StatDir | null;
    private readonly knownDirs = new Map<string, boolean>();
    private readonly chain: Array<{ dir: string; listing: DirListing | null }> = [];
    private readonly storedChain: Array<{ dir: string; stored: StoredDir }> = [];

    constructor(opts: { exists: ExistsProbe; listDir: ListDir; statDir?: StatDir }) {
        this.exists = opts.exists;
        this.listDir = opts.listDir;
        this.statDir = opts.statDir ?? null;
    }

    /** What the cache holds for `dir`, offered when the sweep reaches its row (before any of its children). */
    offerStored(dir: string, stored: StoredDir): void {
        this.popStored(dir);
        this.storedChain.push({ dir, stored });
    }

    fileExists(path: string): boolean {
        const parent = dirname(path);

        if (this.knownDirs.get(parent) === false) {
            return false;
        }

        if (this.listingOf(parent)?.certain(basename(path)) === true) {
            return true;
        }

        if (!this.dirExists(parent)) {
            return false;
        }

        this.probes += 1;
        return this.exists(path);
    }

    dirExists(path: string): boolean {
        const known = this.knownDirs.get(path);
        if (known !== undefined) {
            return known;
        }

        const parent = dirname(path);
        let present: boolean;

        if (parent === path) {
            this.probes += 1;
            present = this.exists(path);
        } else if (this.knownDirs.get(parent) === false) {
            present = false;
        } else if (this.listingOf(parent)?.certain(basename(path)) === true) {
            present = true;
        } else if (!this.dirExists(parent)) {
            present = false;
        } else {
            this.probes += 1;
            present = this.exists(path);
        }

        this.remember(path, present);
        return present;
    }

    /** Some remembered ancestor of `dir` (or `dir` itself) is gone. Map lookups only, no syscall. */
    private knownGone(dir: string): boolean {
        let current = dir;

        for (;;) {
            const known = this.knownDirs.get(current);
            if (known !== undefined) {
                return !known;
            }

            const parent = dirname(current);
            if (parent === current) {
                return false;
            }

            current = parent;
        }
    }

    private remember(dir: string, present: boolean): void {
        if (this.knownDirs.size >= KNOWN_DIRS_LIMIT) {
            this.knownDirs.clear();
        }

        this.knownDirs.set(dir, present);
    }

    private popStored(dir: string): StoredDir | null {
        let top = this.storedChain[this.storedChain.length - 1];

        while (top !== undefined && !isWithin(dir, top.dir)) {
            this.storedChain.pop();
            top = this.storedChain[this.storedChain.length - 1];
        }

        return top?.dir === dir ? top.stored : null;
    }

    /** The answer for `dir` from its stored children, `"gone"` when its stat finds it gone, or null when the stored
     *  children cannot be trusted (no stored row, a changed stamp, a failed stat). */
    private fromStored(dir: string): DirListing | "gone" | null {
        const stored = this.statDir === null ? null : this.popStored(dir);
        if (stored === null || this.statDir === null) {
            return null;
        }

        this.stamps += 1;
        const stamp = this.statDir(dir);
        if (stamp === "gone") {
            return "gone";
        }

        if (stamp === null || !stamp.isDirectory || stamp.mtimeNs !== stored.mtimeNs || stamp.ino !== stored.ino) {
            return null;
        }

        const listing = storedListing(stored.childNamesJson);
        if (listing !== null) {
            this.storedHits += 1;
        }

        return listing;
    }

    private listingOf(dir: string): DirListing | null {
        let top = this.chain[this.chain.length - 1];

        while (top !== undefined && !isWithin(dir, top.dir)) {
            this.chain.pop();
            top = this.chain[this.chain.length - 1];
        }

        if (top?.dir === dir) {
            return top.listing;
        }

        // Under a directory already known gone (a deleted worktree), skip the check that could only fail.
        let listing: DirListing | null = null;
        if (!this.knownGone(dir)) {
            const stored = this.fromStored(dir);
            if (stored === "gone") {
                this.remember(dir, false);
            } else if (stored !== null) {
                listing = stored;
            } else {
                this.listings += 1;
                listing = this.listDir(dir);
            }
        }

        this.chain.push({ dir, listing });

        if (listing !== null) {
            this.remember(dir, true);
        }

        return listing;
    }
}

export function defaultExistsProbe(path: string): boolean {
    return existsSync(path);
}
