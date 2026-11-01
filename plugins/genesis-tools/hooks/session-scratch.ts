/**
 * The session's scratch folder as `tools rm` sees it, for the SessionStart hook to name. A hook script cannot import
 * `@genesiscz/utils`, so this repeats `asideRootFor` in src/utils/rm/aside.ts; a test in src/utils/rm/rm.test.ts
 * checks that both name the same folder.
 */

import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Harness } from "../lib/Generated/harness-facts";

/** The folder under the temp root each harness keeps its scratch in: `AGENT_SCRATCH_DIRS` in src/utils/rm/aside.ts. */
const SCRATCH_DIRS: Record<Harness, string> = { claude: "cc", codex: "codex", grok: "grok" };

/** The same cleaning as `segment()` in src/utils/rm/aside.ts. */
function segment(value: string | null | undefined, fallback: string): string {
    const clean = (value ?? "").replace(/[^\w.-]/g, "_").slice(0, 80);
    return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

/** `/tmp/<agent dir>/<project>/<full session id>`: `tools rm` deletes inside it without asking. */
export function sessionScratchPath(input: { harness: Harness; project: string | null; sessionId: string }): string {
    const root = process.platform === "win32" ? tmpdir() : "/tmp";
    return join(
        root,
        SCRATCH_DIRS[input.harness],
        segment(input.project, "unknown-project"),
        segment(input.sessionId, "no-session")
    );
}

/** The project as `tools rm` names it: the main checkout's folder (the parent of the shared `.git`), else the cwd's. */
export function projectOf(cwd: string): string {
    const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        stdout: "pipe",
        stderr: "ignore",
    });
    const common = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    return basename(common ? dirname(common) : cwd);
}
