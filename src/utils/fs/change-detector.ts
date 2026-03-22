export interface ChangeSet {
    /** Paths present in current but not in previous */
    added: string[];
    /** Paths present in both, but with different hashes */
    modified: string[];
    /** Paths present in previous but not in current */
    deleted: string[];
    /** Paths present in both with identical hashes */
    unchanged: string[];
}

export interface ChangeDetectorOptions {
    /** Hash function: (content) => hash string. Default: Bun.hash xxHash64 */
    hashFn?: (content: string) => string;
}

/** Default hash function using Bun's xxHash64 */
export function defaultHash(content: string): string {
    return Bun.hash(content).toString(16);
}

/**
 * Compute the changeset between two snapshots.
 *
 * @param input.current  - Map of path -> content
 * @param input.previous - Map of path -> hash from last run (empty map = first run, everything is "added")
 * @param input.hashFn   - Optional hash function override (default: xxHash64)
 * @returns ChangeSet with added/modified/deleted/unchanged paths
 */
interface DetectChangesInput {
    current: Map<string, string>;
    previous: Map<string, string>;
    hashFn?: (content: string) => string;
}

export function detectChanges(input: DetectChangesInput): ChangeSet {
    const { current, previous, hashFn = defaultHash } = input;
    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    const currentKeys = new Set<string>();

    for (const [path, content] of current) {
        currentKeys.add(path);
        const prevHash = previous.get(path);
        const currentHash = hashFn(content);

        if (prevHash === undefined) {
            added.push(path);
        } else if (prevHash !== currentHash) {
            modified.push(path);
        } else {
            unchanged.push(path);
        }
    }

    const deleted: string[] = [];

    for (const path of previous.keys()) {
        if (!currentKeys.has(path)) {
            deleted.push(path);
        }
    }

    return { added, modified, deleted, unchanged };
}

/**
 * Same as detectChanges but accepts pre-hashed current entries.
 * Use when you already have hashes and don't need to re-hash content.
 */
interface DetectChangesPreHashedInput {
    currentHashes: Map<string, string>;
    previousHashes: Map<string, string>;
}

export function detectChangesPreHashed(input: DetectChangesPreHashedInput): ChangeSet {
    const { currentHashes, previousHashes } = input;
    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    const currentKeys = new Set<string>();

    for (const [path, hash] of currentHashes) {
        currentKeys.add(path);
        const prevHash = previousHashes.get(path);

        if (prevHash === undefined) {
            added.push(path);
        } else if (prevHash !== hash) {
            modified.push(path);
        } else {
            unchanged.push(path);
        }
    }

    const deleted: string[] = [];

    for (const path of previousHashes.keys()) {
        if (!currentKeys.has(path)) {
            deleted.push(path);
        }
    }

    return { added, modified, deleted, unchanged };
}
