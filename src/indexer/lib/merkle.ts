import { dirname, relative, sep } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { MerkleNode } from "./types";

/**
 * Compute SHA-256 hash of a string using Bun's native CryptoHasher.
 */
function sha256(input: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex");
}

/**
 * Build a Merkle tree from a list of files and their chunk hashes.
 *
 * - File hash = SHA-256 of sorted chunk hashes concatenated
 * - Directory hash = SHA-256 of sorted children hashes concatenated
 * - The root node represents `baseDir`
 */
export function buildMerkleTree(opts: {
    baseDir: string;
    files: Array<{ path: string; chunkHashes: string[] }>;
}): MerkleNode {
    const { baseDir, files } = opts;

    // Build a map of directory path -> children nodes
    const dirChildren = new Map<string, MerkleNode[]>();
    dirChildren.set("", []);

    for (const file of files) {
        const relPath = relative(baseDir, file.path);
        const chunkHashes = [...file.chunkHashes].sort();
        const fileHash = sha256(`${relPath}\0${chunkHashes.join("")}`);

        const fileNode: MerkleNode = {
            hash: fileHash,
            path: relPath,
            isFile: true,
            chunkHashes: file.chunkHashes,
        };

        // Ensure all ancestor directories exist in the map
        const dir = dirname(relPath);
        const parts = dir === "." ? [] : dir.split(sep);
        let current = "";

        for (const part of parts) {
            const parent = current;
            current = current ? `${current}${sep}${part}` : part;

            if (!dirChildren.has(current)) {
                dirChildren.set(current, []);

                // Register this directory in its parent's children (placeholder; hash computed later)
                if (!dirChildren.has(parent)) {
                    dirChildren.set(parent, []);
                }
            }
        }

        // Add file to its directory
        const parentDir = dir === "." ? "" : dir;

        if (!dirChildren.has(parentDir)) {
            dirChildren.set(parentDir, []);
        }

        dirChildren.get(parentDir)!.push(fileNode);
    }

    // Build tree bottom-up: compute directory hashes
    return buildDirNode("", baseDir, dirChildren);
}

/**
 * Recursively build a directory node, computing its hash from children.
 */
function buildDirNode(dirRelPath: string, baseDir: string, dirChildren: Map<string, MerkleNode[]>): MerkleNode {
    const directChildren = dirChildren.get(dirRelPath) ?? [];

    // Find subdirectories that are direct children of this directory
    const subdirs: string[] = [];

    for (const key of dirChildren.keys()) {
        if (key === dirRelPath) {
            continue;
        }

        // A direct child directory has this dir as its parent
        const parent = dirname(key);
        const normalizedParent = parent === "." ? "" : parent;

        if (normalizedParent === dirRelPath) {
            subdirs.push(key);
        }
    }

    // Recursively build subdirectory nodes
    const subDirNodes = subdirs.map((subdir) => buildDirNode(subdir, baseDir, dirChildren));

    const allChildren = [...directChildren, ...subDirNodes].sort((a, b) => a.path.localeCompare(b.path));

    const childHashes = allChildren.map((c) => c.hash).sort();
    const dirPath = dirRelPath || ".";
    const hash = sha256(`${dirPath}\0${childHashes.join("")}`);

    return {
        hash,
        path: dirPath,
        children: allChildren.length > 0 ? allChildren : undefined,
    };
}

export interface MerkleDiff {
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
}

/**
 * Diff two Merkle trees to find added, modified, deleted, and unchanged files.
 *
 * Key optimization: when directory hashes match, skip the entire subtree.
 */
export function diffMerkleTrees(opts: { previous: MerkleNode | null; current: MerkleNode }): MerkleDiff {
    const { previous, current } = opts;

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    if (!previous) {
        // Everything is new
        collectFiles(current, added);
        return { added, modified, deleted, unchanged };
    }

    diffNodes(previous, current, added, modified, deleted, unchanged);

    return { added, modified, deleted, unchanged };
}

/**
 * Collect all file paths from a tree node.
 */
function collectFiles(node: MerkleNode, target: string[]): void {
    if (node.isFile) {
        target.push(node.path);
        return;
    }

    if (node.children) {
        for (const child of node.children) {
            collectFiles(child, target);
        }
    }
}

/**
 * Recursively diff two nodes.
 */
function diffNodes(
    prev: MerkleNode,
    curr: MerkleNode,
    added: string[],
    modified: string[],
    deleted: string[],
    unchanged: string[]
): void {
    // Short-circuit: identical hashes means entire subtree is unchanged
    if (prev.hash === curr.hash) {
        collectFiles(curr, unchanged);
        return;
    }

    // Both are files — same path, different hash means modified
    if (prev.isFile && curr.isFile) {
        modified.push(curr.path);
        return;
    }

    // Both are directories — diff their children
    if (!prev.isFile && !curr.isFile) {
        const prevMap = new Map<string, MerkleNode>();
        const currMap = new Map<string, MerkleNode>();

        if (prev.children) {
            for (const child of prev.children) {
                prevMap.set(child.path, child);
            }
        }

        if (curr.children) {
            for (const child of curr.children) {
                currMap.set(child.path, child);
            }
        }

        // Find deleted (in prev but not in curr)
        for (const [path, node] of prevMap) {
            if (!currMap.has(path)) {
                collectFiles(node, deleted);
            }
        }

        // Find added (in curr but not in prev)
        for (const [path, node] of currMap) {
            if (!prevMap.has(path)) {
                collectFiles(node, added);
            }
        }

        // Find modified/unchanged (in both)
        for (const [path, currChild] of currMap) {
            const prevChild = prevMap.get(path);

            if (!prevChild) {
                continue;
            }

            diffNodes(prevChild, currChild, added, modified, deleted, unchanged);
        }

        return;
    }

    // Type mismatch (directory became file or vice versa) — treat as delete + add
    collectFiles(prev, deleted);
    collectFiles(curr, added);
}

/**
 * Serialize a Merkle tree to JSON string for storage.
 */
export function serializeMerkleTree(tree: MerkleNode): string {
    return SafeJSON.stringify(tree);
}

/**
 * Deserialize a Merkle tree from a JSON string.
 */
export function deserializeMerkleTree(json: string): MerkleNode {
    return SafeJSON.parse(json, { strict: true }) as MerkleNode;
}
