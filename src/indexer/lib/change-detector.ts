import { relative } from "node:path";
import { buildMerkleTree, diffMerkleTrees } from "./merkle";
import type { MerkleNode } from "./types";

export interface DetectedChanges {
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
    strategy: string;
}

interface DetectChangesOpts {
    baseDir: string;
    strategy: "git" | "merkle" | "git+merkle" | "chokidar";
    previousMerkle: MerkleNode | null;
    currentChunks: Map<string, string[]>;
    respectGitIgnore?: boolean;
}

/**
 * Detect file changes using the specified strategy.
 */
export async function detectChanges(opts: DetectChangesOpts): Promise<DetectedChanges> {
    const { strategy } = opts;

    switch (strategy) {
        case "git":
            return detectGit(opts);
        case "merkle":
            return detectMerkle(opts);
        case "git+merkle":
            return detectGitMerkle(opts);
        case "chokidar":
            return {
                added: [],
                modified: [],
                deleted: [],
                unchanged: [],
                strategy: "chokidar",
            };
    }
}

/**
 * Check if the given directory is inside a git repository.
 */
async function isGitRepo(baseDir: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: baseDir,
        stdout: "pipe",
        stderr: "pipe",
    });

    await proc.exited;
    return proc.exitCode === 0;
}

/**
 * Check if the repository has at least one commit (HEAD exists).
 */
async function hasHead(baseDir: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "rev-parse", "--verify", "HEAD"], {
        cwd: baseDir,
        stdout: "pipe",
        stderr: "pipe",
    });

    await proc.exited;
    return proc.exitCode === 0;
}

interface GitFileStatus {
    status: "A" | "M" | "D" | "?" | string;
    path: string;
}

/**
 * Parse `git diff --name-status HEAD` output into file statuses.
 */
function parseDiffNameStatus(output: string): GitFileStatus[] {
    const results: GitFileStatus[] = [];

    for (const line of output.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        // Format: "M\tpath/to/file" or "A\tpath/to/file"
        const match = trimmed.match(/^([AMDRC])\d*\t(.+)$/);

        if (match) {
            results.push({
                status: match[1],
                path: match[2],
            });
        }
    }

    return results;
}

/**
 * Parse `git status --porcelain` output into file statuses.
 */
function parseStatusPorcelain(output: string): GitFileStatus[] {
    const results: GitFileStatus[] = [];

    for (const line of output.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        // Porcelain format: "XY path" where X=index, Y=worktree
        const indexStatus = line[0];
        const worktreeStatus = line[1];
        const path = line.slice(3);

        if (indexStatus === "?" || worktreeStatus === "?") {
            results.push({ status: "A", path });
        } else if (indexStatus === "D" || worktreeStatus === "D") {
            results.push({ status: "D", path });
        } else {
            results.push({ status: "M", path });
        }
    }

    return results;
}

/**
 * Git-based change detection.
 * Uses `git diff --name-status HEAD` for committed repos,
 * falls back to `git status --porcelain` for repos with no HEAD.
 */
async function detectGit(opts: DetectChangesOpts): Promise<DetectedChanges> {
    const { baseDir, currentChunks } = opts;

    if (!(await isGitRepo(baseDir))) {
        return {
            added: [],
            modified: [],
            deleted: [],
            unchanged: [],
            strategy: "git (not a git repo — use merkle instead)",
        };
    }

    let statuses: GitFileStatus[];

    if (await hasHead(baseDir)) {
        // Has commits — use diff against HEAD
        const proc = Bun.spawn(["git", "diff", "--name-status", "HEAD"], {
            cwd: baseDir,
            stdout: "pipe",
            stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        statuses = parseDiffNameStatus(stdout);

        // Also check untracked files
        const untrackedProc = Bun.spawn(["git", "ls-files", "--others", "--exclude-standard"], {
            cwd: baseDir,
            stdout: "pipe",
            stderr: "pipe",
        });

        const untrackedOut = await new Response(untrackedProc.stdout).text();
        await untrackedProc.exited;

        for (const line of untrackedOut.split("\n")) {
            const trimmed = line.trim();

            if (trimmed) {
                statuses.push({ status: "A", path: trimmed });
            }
        }
    } else {
        // No commits yet — use porcelain status
        const proc = Bun.spawn(["git", "status", "--porcelain"], {
            cwd: baseDir,
            stdout: "pipe",
            stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        statuses = parseStatusPorcelain(stdout);
    }

    const changedSet = new Set<string>();
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const { status, path } of statuses) {
        changedSet.add(path);

        if (status === "A" || status === "?") {
            added.push(path);
        } else if (status === "D") {
            deleted.push(path);
        } else {
            modified.push(path);
        }
    }

    // Files in currentChunks that are not in the changed set are unchanged
    const unchanged: string[] = [];

    for (const filePath of currentChunks.keys()) {
        const relPath = relative(baseDir, filePath);

        if (!changedSet.has(relPath)) {
            unchanged.push(relPath);
        }
    }

    return { added, modified, deleted, unchanged, strategy: "git" };
}

/**
 * Merkle tree-based change detection.
 * Compares previous and current Merkle trees built from chunk hashes.
 */
async function detectMerkle(opts: DetectChangesOpts): Promise<DetectedChanges> {
    const { baseDir, previousMerkle, currentChunks } = opts;

    const currentTree = buildMerkleTree({
        baseDir,
        files: Array.from(currentChunks.entries()).map(([path, chunkHashes]) => ({
            path,
            chunkHashes,
        })),
    });

    const diff = diffMerkleTrees({
        previous: previousMerkle,
        current: currentTree,
    });

    return {
        ...diff,
        strategy: "merkle",
    };
}

/**
 * Hybrid git+merkle change detection.
 *
 * 1. Git determines which FILES changed (fast filesystem-level check).
 * 2. For those files, Merkle tree determines which CHUNKS changed.
 * 3. Returns file-level changes but preserves chunk hashes for later dedup.
 */
async function detectGitMerkle(opts: DetectChangesOpts): Promise<DetectedChanges> {
    const { baseDir, previousMerkle, currentChunks } = opts;

    // Step 1: Use git to find which files changed
    const gitResult = await detectGit(opts);

    // If git isn't available, fall back to pure merkle
    if (gitResult.strategy.includes("not a git repo")) {
        const merkleResult = await detectMerkle(opts);
        return {
            ...merkleResult,
            strategy: "git+merkle (fell back to merkle — not a git repo)",
        };
    }

    // Step 2: For modified files, use merkle to verify at chunk level
    // A file git reports as modified might have chunks that didn't actually change
    // (e.g. only whitespace or comments changed in part of the file)
    if (!previousMerkle) {
        return {
            ...gitResult,
            strategy: "git+merkle (no previous merkle — using git only)",
        };
    }

    // Build current merkle tree for comparison
    const currentTree = buildMerkleTree({
        baseDir,
        files: Array.from(currentChunks.entries()).map(([path, chunkHashes]) => ({
            path,
            chunkHashes,
        })),
    });

    const merkleDiff = diffMerkleTrees({
        previous: previousMerkle,
        current: currentTree,
    });

    // Merge: git for add/delete detection, merkle for modified verification
    // A file git says is "modified" but merkle says is "unchanged" means
    // only non-content changes (metadata, whitespace outside chunks)
    const merkleUnchangedSet = new Set(merkleDiff.unchanged);

    const trueModified: string[] = [];
    const trueUnchanged: string[] = [...merkleDiff.unchanged];

    for (const path of gitResult.modified) {
        if (merkleUnchangedSet.has(path)) {
            // Git says modified, but chunk content is the same — treat as unchanged
            // (already in trueUnchanged from merkleDiff)
        } else {
            trueModified.push(path);
        }
    }

    return {
        added: gitResult.added,
        modified: trueModified,
        deleted: gitResult.deleted,
        unchanged: trueUnchanged,
        strategy: "git+merkle",
    };
}
