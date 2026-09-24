import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `work` inside a private temporary directory and removes it afterwards, whatever happens.
 *
 * The replay scripts hand real shell commands to a child process through files, and those commands
 * come from transcripts and decision logs, inline secrets included. `mkdtemp` makes the directory
 * 0700, `write` makes every file 0600, and the `finally` means nothing outlives the run. Writing
 * straight into the shared temp folder left them there at the umask's mode, readable by other
 * local users, with no cleanup.
 */
export function withPrivateTempDir<T>(prefix: string, work: (dir: PrivateTempDir) => T): T {
    const path = mkdtempSync(join(tmpdir(), prefix));

    try {
        return work({
            path,
            write: (name: string, contents: string): string => {
                const file = join(path, name);

                writeFileSync(file, contents, { mode: 0o600 });
                return file;
            },
        });
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
}

export interface PrivateTempDir {
    path: string;
    /** Writes `name` inside the directory with mode 0600 and returns its full path. */
    write: (name: string, contents: string) => string;
}
