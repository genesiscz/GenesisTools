import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** Well inside a hook's own 15 s budget, so a stuck `git` fails the store, not the hook. */
const GIT_TIMEOUT_MS = 8_000;

/**
 * The change-log object store: one bare repo for every session, which the agents hooks write the before and after
 * bytes of each changed file into (`git hash-object -w` stores identical bytes once), and which each row of
 * `~/.genesis-tools/agents/<session>/changes.jsonl` names by oid. It has no refs.
 */
export function objectsDir(): string {
    return genesisToolsDir("agents", "_objects");
}

/** The maintenance step's own files (its lock, the objects it moves aside), inside the store. */
export function maintenanceDir(gitDir: string): string {
    return join(gitDir, "gt-maintenance");
}

/**
 * The store has no refs, so to git every object is unreachable: an automatic or hand-run `git gc` or `git prune`
 * would delete every loose object older than two weeks. These keys stop both. Returns the keys it could not set.
 */
export function guardStoreAgainstGc(gitDir: string): string[] {
    const failed: string[] = [];

    for (const [key, value] of [
        ["gc.auto", "0"],
        ["gc.pruneExpire", "never"],
    ]) {
        const run = spawnSync("git", ["--git-dir", gitDir, "config", key, value], { timeout: GIT_TIMEOUT_MS });

        if (run.status !== 0) {
            failed.push(key);
        }
    }

    return failed;
}

/** Creates the bare repo on first use, with the gc guard. */
export function ensureObjectStore(gitDir: string): void {
    mkdirSync(gitDir, { recursive: true });

    if (existsSync(join(gitDir, "HEAD"))) {
        return;
    }

    const init = spawnSync("git", ["init", "--bare", gitDir], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });

    if (init.status !== 0) {
        throw new Error(init.stderr || `git init failed${init.error ? `: ${init.error.message}` : ""}`);
    }

    guardStoreAgainstGc(gitDir);
}

export function gitOutputOrThrow(run: ReturnType<typeof spawnSync>, what: string): string {
    if (run.status !== 0) {
        const reason = run.error ? run.error.message : (run.stderr?.toString() ?? "");
        throw new Error(`${what} failed${reason ? `: ${reason}` : ""}`);
    }

    return run.stdout.toString();
}

/** Every blob through one `git hash-object -w --stdin-paths`, from files in a scratch dir; oids in the same order. */
export function writeBlobs(gitDir: string, blobs: readonly Buffer[]): string[] {
    ensureObjectStore(gitDir);
    const scratch = mkdtempSync(join(tmpdir(), "gt-change-blobs-"));

    try {
        const paths = blobs.map((bytes, index) => {
            const path = join(scratch, String(index));
            writeFileSync(path, bytes);
            return path;
        });
        const run = spawnSync("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin-paths"], {
            input: `${paths.join("\n")}\n`,
            // One oid line per blob (65 bytes at most, sha256). The 1 MiB default failed past
            // about 25k blobs, and the fallback then started one `git` per blob.
            maxBuffer: (blobs.length + 1) * 72,
            timeout: GIT_TIMEOUT_MS,
        });
        const oids = gitOutputOrThrow(run, "git hash-object --stdin-paths").trim().split("\n");

        if (oids.length !== blobs.length) {
            throw new Error(`git hash-object returned ${oids.length} ids for ${blobs.length} blobs`);
        }

        return oids;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
