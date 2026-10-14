import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env.client";
import { tmpdir } from "@genesiscz/utils/paths";

/**
 * A file a test executes, made once per `key` and kept for later runs. Returns its path.
 *
 * On 2026-10-14 the Mac froze (WindowServer watchdog, 20:06) after macOS's syspolicyd crashed five times on
 * executables that tests had just created and then renamed or deleted: a fresh copy of bun per run, and fake
 * tools inside the per-run temp root that is removed after every green run. A fixture made here lives next to
 * that root, in the real temp folder, so the cleanup never reaches it, and nothing renames or deletes it. A new
 * `key` (another bun build, another script body) gives a new folder instead of overwriting a file that may run.
 *
 * Concurrent runs are safe: each one writes a draft inside its own temp root and hard-links it into place, and
 * the run that loses the race uses the winner's file. The draft name goes with the temp root; the file stays.
 */
export function persistentFixture(name: string, key: string, create: (path: string) => void): string {
    const sandbox = env.test.getTmpRoot();
    const root = join(sandbox ? dirname(sandbox) : tmpdir(), "gt-test-fixtures");
    const path = join(root, createHash("sha256").update(key).digest("hex").slice(0, 16), name);

    if (existsSync(path)) {
        return path;
    }

    mkdirSync(dirname(path), { recursive: true });
    const draft = join(mkdtempSync(join(tmpdir(), "fixture-")), name);
    create(draft);

    try {
        linkSync(draft, path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
        }
    }

    return path;
}
