import { spawnSync } from "node:child_process";
import { logger } from "@genesiscz/utils/logger";

export type GitDiffReader = (against: string) => string;

/**
 * Paths under `against` that `git diff --name-only HEAD` reports as changed. The reader is
 * injectable so tests can drive `--only-changed` without a repository.
 */
export function changedFiles(against = "src", git: GitDiffReader = runGitDiff): string[] {
    const output = git(against);
    const files = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && (against === "." || against === "" || line.startsWith(against)));
    logger.info({ against, changed: files.length }, "Read the changed-file set from git");
    return files;
}

export function runGitDiff(against: string): string {
    logger.debug(
        { argv: ["git", "diff", "--name-only", "HEAD", "--", against] },
        "Spawning git diff for --only-changed"
    );
    const result = spawnSync("git", ["diff", "--name-only", "HEAD", "--", against], {
        encoding: "utf8",
        timeout: 15_000,
    });

    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "git diff --name-only failed.");
    }

    return result.stdout;
}
