import { spawnSync } from "node:child_process";
import { ensureObjectStore, gitOutputOrThrow, objectsDir, writeBlobs } from "@genesiscz/utils/agents/objects/store";
import type { ChangeSink } from "./log";

export { objectsDir } from "@genesiscz/utils/agents/objects/store";

/** Well inside the hook's own 15 s budget, so a stuck `git` fails the store, not the hook. */
const GIT_TIMEOUT_MS = 8_000;

/** The store's size is kept by the daily pass's object-store step (`@genesiscz/utils/agents/objects/maintain`). */
export function gitObjectSink(gitDir = objectsDir(), log: (line: string) => void = () => undefined): ChangeSink {
    return {
        hash(bytes) {
            ensureObjectStore(gitDir);
            const run = spawnSync("git", ["--git-dir", gitDir, "hash-object", "-w", "--stdin"], {
                input: bytes,
                timeout: GIT_TIMEOUT_MS,
            });
            return gitOutputOrThrow(run, "git hash-object").trim();
        },
        /** Every blob through one `git hash-object -w --stdin-paths`, from files in a scratch dir. */
        hashAll(blobs) {
            return writeBlobs(gitDir, blobs);
        },
        log,
    };
}
