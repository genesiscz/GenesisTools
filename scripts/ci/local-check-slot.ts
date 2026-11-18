import { join } from "node:path";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { spawnWithDeadline } from "./spawn-deadline";

/** Linked worktrees share this slot; their passing results and incremental files remain separate. */
export async function withLocalCheckSlot<T>(run: () => Promise<T>): Promise<T> {
    const common = spawnWithDeadline(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.exitCode !== 0 || !common.stdout.toString().trim()) {
        throw new Error(`Cannot locate the shared Git directory: ${common.stderr.toString().trim()}`);
    }
    return withFileLock(join(common.stdout.toString().trim(), "genesis-heavy-check.lock"), run, 15 * 60_000);
}
