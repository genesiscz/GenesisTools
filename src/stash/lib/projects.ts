import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@app/logger";
import { runGitIn } from "./patch";

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
    if (!project?.origin) {
        return [];
    }
    const parent = dirname(project.rootPath);
    const entries = await readdir(parent, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = join(parent, entry.name);
        if (candidate === project.rootPath) {
            continue;
        }
        if (!existsSync(join(candidate, ".git"))) {
            continue;
        }
        const other = await detectProject(candidate);
        if (other?.origin === project.origin) {
            out.push(candidate);
        }
    }
    return out.sort();
}
