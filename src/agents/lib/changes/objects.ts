import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { ChangeSink } from "./log";

/** Well inside the hook's own 15 s budget, so a stuck `git` fails the store, not the hook. */
const GIT_TIMEOUT_MS = 8_000;

/** One bare repo for every session. `git hash-object -w` stores identical bytes once. */
export function objectsDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "agents", "_objects");
}

function ensureRepo(gitDir: string): void {
    mkdirSync(gitDir, { recursive: true });

    if (existsSync(join(gitDir, "HEAD"))) {
        return;
    }

    const init = spawnSync("git", ["init", "--bare", gitDir], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });

    if (init.status !== 0) {
        throw new Error(init.stderr || `git init failed${init.error ? `: ${init.error.message}` : ""}`);
    }
}

function hashedOrThrow(run: ReturnType<typeof spawnSync>, what: string): string {
    if (run.status !== 0) {
        const reason = run.error ? run.error.message : (run.stderr?.toString() ?? "");
        throw new Error(`${what} failed${reason ? `: ${reason}` : ""}`);
    }

    return run.stdout.toString();
}

export function gitObjectSink(gitDir = objectsDir(), log: (line: string) => void = () => undefined): ChangeSink {
    return {
        hash(bytes) {
            ensureRepo(gitDir);
            const run = spawnSync("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin"], {
                input: bytes,
                timeout: GIT_TIMEOUT_MS,
            });
            return hashedOrThrow(run, "git hash-object").trim();
        },
        /** Every blob through one `git hash-object -w --stdin-paths`, from files in a scratch dir. */
        hashAll(blobs) {
            ensureRepo(gitDir);
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
                const oids = hashedOrThrow(run, "git hash-object --stdin-paths").trim().split("\n");

                if (oids.length !== blobs.length) {
                    throw new Error(`git hash-object returned ${oids.length} ids for ${blobs.length} blobs`);
                }

                return oids;
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        log,
    };
}
