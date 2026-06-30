import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import { runGitIn } from "./patch";
import { computeTreeHashSimilarity, DEFAULT_TREE_HASH_THRESHOLD, listTopFilePaths } from "./sibling-clone-tree-hash";

const log = logger.scoped("stash:projects").log;

export interface DetectedProject {
    rootPath: string;
    origin: string | null;
    sha: string | null;
}

export function normalizeOrigin(url: string): string {
    let u = url.trim().replace(/\.git$/, "");
    // SSH form `git@host:owner/repo` → captured host + path.
    const ssh = /^git@([^:]+):(.+)$/.exec(u);
    if (ssh) {
        u = `${ssh[1]}/${ssh[2]}`;
    } else {
        // Strip `scheme://user@` from HTTPS/git URLs.
        u = u.replace(/^[a-z]+:\/\/(?:[^@]+@)?/, "");
    }
    const slash = u.indexOf("/");
    if (slash > 0) {
        const host = u.slice(0, slash).toLowerCase();
        return `${host}${u.slice(slash)}`;
    }
    return u.toLowerCase();
}

export async function detectProject(cwd: string): Promise<DetectedProject | null> {
    try {
        const root = (await runGitIn(cwd, ["rev-parse", "--show-toplevel"])).trim();
        let origin: string | null = null;
        try {
            const raw = (await runGitIn(root, ["config", "--get", "remote.origin.url"])).trim();
            if (raw) {
                origin = normalizeOrigin(raw);
            }
        } catch (err) {
            log.debug({ err, root }, "no origin configured");
        }
        let sha: string | null = null;
        try {
            sha = (await runGitIn(root, ["rev-parse", "HEAD"])).trim();
        } catch (err) {
            log.debug({ err, root }, "empty repo or no HEAD");
        }
        return { rootPath: root, origin, sha };
    } catch (err) {
        log.debug({ err, cwd }, "not a git repository");
        return null;
    }
}

export async function findSiblingClones(projectPath: string): Promise<string[]> {
    const project = await detectProject(projectPath);

    if (!project) {
        return [];
    }

    const parent = dirname(project.rootPath);
    const entries = await readdir(parent, { withFileTypes: true });
    // Sync filter first: drop non-dirs, self, and anything without a `.git` (so we don't pay 2-3
    // git-subprocess spawns on directories that obviously aren't clones).
    const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(parent, entry.name))
        .filter((candidate) => candidate !== project.rootPath && existsSync(join(candidate, ".git")));

    // Fast path: origin URL is available — match by normalised remote URL.
    // PR #222 t19: parallelize the per-candidate `detectProject` (each spawns up to 3 git subprocesses).
    // Bounded at 8 — naked `Promise.all` on 50+ siblings has previously caused FD/vnode pressure on
    // this machine; concurrentMap (Promise.allSettled-based) drops failures silently so one bad
    // candidate doesn't kill the whole sweep.
    if (project.origin) {
        const detected = await concurrentMap({
            items: candidates,
            concurrency: 8,
            fn: async (candidate) => detectProject(candidate),
            onError: (candidate, err) => log.debug({ err, candidate }, "sibling detect failed (skipped)"),
        });
        const out: string[] = [];

        for (const [candidate, other] of detected) {
            if (other?.origin === project.origin) {
                out.push(candidate);
            }
        }

        return out.sort();
    }

    // Fallback: no remote.origin.url — compute Jaccard similarity of top-100 file paths.
    // Threshold DEFAULT_TREE_HASH_THRESHOLD (0.7) → treat as sibling.
    // Bounded at 4 to limit parallel git-ls-files invocations.
    log.debug(
        { rootPath: project.rootPath, candidateCount: candidates.length },
        "no origin; falling back to tree-hash similarity"
    );
    // Precompute the base file path set ONCE so each candidate only pays for its own ls-files,
    // not a duplicate scan of the project root we already know.
    const baseSet = new Set(await listTopFilePaths(project.rootPath));
    const simResults = await concurrentMap({
        items: candidates,
        concurrency: 4,
        fn: async (candidate) => computeTreeHashSimilarity(project.rootPath, candidate, baseSet),
        onError: (candidate, err) => log.debug({ err, candidate }, "tree-hash similarity failed (skipped)"),
    });
    const out: string[] = [];

    for (const [candidate, sim] of simResults) {
        if (sim >= DEFAULT_TREE_HASH_THRESHOLD) {
            out.push(candidate);
        }
    }

    return out.sort();
}
