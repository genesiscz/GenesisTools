import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import type { DeployedFile } from "./deployed.ts";

const prof = profiler.scope("sourcemaps");

export interface CommitHint {
    commit: string;
    /** How often the full sha appears in the deployed JS. */
    occurrences: number;
    /** Deployed files that contain it (first 5). */
    files: string[];
}

const SHA = /\b[0-9a-f]{40}\b/g;

/**
 * Zero-build first step: many builds inline the commit they were built from (a build-info object, a release
 * name, a version endpoint). Collect every 40-hex string in the deployed JS and keep the ones `git cat-file`
 * confirms as commits of `repo`. A crypto constant or a random id is not a commit, so it drops out.
 */
export async function findCommitHints(options: {
    repo: string;
    deployed: { dir: string; files: DeployedFile[] };
}): Promise<CommitHint[]> {
    const stopProfile = prof.start("hints");
    try {
        const seen = new Map<string, { occurrences: number; files: Set<string> }>();
        for (const file of options.deployed.files.filter((candidate) => /\.m?js$/.test(candidate.path))) {
            const code = await readFile(join(options.deployed.dir, file.path), "utf8");
            for (const match of code.matchAll(SHA)) {
                const entry = seen.get(match[0]) ?? { occurrences: 0, files: new Set<string>() };
                entry.occurrences++;
                entry.files.add(file.path);
                seen.set(match[0], entry);
            }
        }

        if (seen.size === 0) {
            return [];
        }

        const shas = [...seen.keys()];
        const proc = Bun.spawn(["git", "-C", options.repo, "cat-file", "--batch-check"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        proc.stdin.write(shas.map((sha) => `${sha}^{commit}\n`).join(""));
        proc.stdin.end();
        const [output, , code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (code !== 0) {
            throw new Error(`git cat-file --batch-check failed (${code}) in ${options.repo}`);
        }

        const commits = new Set(
            output
                .split("\n")
                .filter((line) => / commit \d+$/.test(line))
                .map((line) => line.split(" ")[0])
        );
        return shas
            .filter((sha) => commits.has(sha))
            .map((sha) => {
                const entry = seen.get(sha) as { occurrences: number; files: Set<string> };
                return { commit: sha, occurrences: entry.occurrences, files: [...entry.files].slice(0, 5) };
            })
            .sort((a, b) => b.occurrences - a.occurrences);
    } finally {
        stopProfile();
    }
}
