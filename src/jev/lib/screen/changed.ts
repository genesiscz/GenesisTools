import { spawnSync } from "node:child_process";

export function changedFiles(against = "src", git = runGitDiff): string[] {
    const output = git(against);
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && (line.startsWith(against) || against === "." || against === ""));
}

export function runGitDiff(against: string): string {
    const result = spawnSync("git", ["diff", "--name-only", "HEAD", "--", against], {
        encoding: "utf8",
        timeout: 15_000,
    });
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "git diff --name-only failed.");
    }

    return result.stdout;
}
