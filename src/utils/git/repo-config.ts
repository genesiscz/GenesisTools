import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { createGit } from "./core";

/**
 * Per-repository policy file, `genesis-tools.config.json`, shared by every
 * tool. Only the `git` section is defined here; other tools add their own
 * top-level sections, which is why the file name is not git-specific.
 *
 * Lookup order (first hit wins):
 *   1. `<repo-root>/.claude/genesis-tools.config.json` — versioned when the
 *      repo tracks `.claude/`.
 *   2. `<git-common-dir>/genesis-tools.config.json` — local, never versioned,
 *      and shared by every worktree of the clone because the common dir is
 *      one directory. In a worktree `.git` is a file, so the path always goes
 *      through `rev-parse --git-common-dir`, never `.git/`.
 */
export const REPO_CONFIG_FILENAME = "genesis-tools.config.json";

export const PUSH_POLICIES = ["confirm", "never", "allowed"] as const;
export type PushPolicy = (typeof PUSH_POLICIES)[number];

export const DEPLOY_DRIVERS = ["jenkins", "github", "gitlab"] as const;
export type DeployDriver = (typeof DEPLOY_DRIVERS)[number];

export interface BranchEntry {
    /** Exact branch name. Exactly one of `name`, `nameRegex`, `catchAll`. */
    name?: string;
    /** JavaScript regular expression matched against the branch name. */
    nameRegex?: string;
    /** Matches every branch; must be the last entry. */
    catchAll?: boolean;
    /** `confirm` (default) asks every time, `never` refuses and prints the command, `allowed` never prompts. */
    push?: PushPolicy;
    /** Data for later versions: what merging into this branch deploys to. */
    environment?: string;
    autoDeploys?: boolean;
    deployDriver?: DeployDriver;
}

export interface GitSection {
    /** Default PR/MR target and cascade target, e.g. `feature/next`. */
    mainPrBranch?: string;
    /** First match top-down wins. */
    branches?: BranchEntry[];
}

export interface RepoConfig {
    git?: GitSection;
    [section: string]: unknown;
}

export type RepoConfigSource = "claude" | "git-dir" | "none";

export interface RepoConfigPaths {
    repoRoot: string;
    commonDir: string;
    claude: string;
    gitDir: string;
}

export interface LoadedRepoConfig {
    config: RepoConfig;
    source: RepoConfigSource;
    /** Absolute path of the file that was read; null when no file exists. */
    path: string | null;
    /** Validation problems. The config is still returned; callers are lenient but must say so. */
    problems: string[];
    paths: RepoConfigPaths;
}

export type BranchMatchedBy = "name" | "nameRegex" | "catchAll" | "none";

export interface BranchPolicy {
    push: PushPolicy;
    environment?: string;
    autoDeploys?: boolean;
    deployDriver?: DeployDriver;
    matchedBy: BranchMatchedBy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Both lookup locations for `cwd`, resolved through git so worktrees share one file. */
export async function repoConfigPaths(cwd: string): Promise<RepoConfigPaths> {
    let layout: { repoRoot: string; commonDir: string };

    try {
        layout = await createGit({ cwd }).layout();
    } catch (err) {
        logger.debug({ err, cwd }, "repo-config: not a repository");
        throw new Error(`Not in a git repository: ${cwd}`);
    }

    const { repoRoot, commonDir } = layout;

    if (!repoRoot || !commonDir) {
        throw new Error(`Could not resolve the repository layout for ${cwd}`);
    }

    return {
        repoRoot,
        commonDir,
        claude: join(repoRoot, ".claude", REPO_CONFIG_FILENAME),
        gitDir: join(commonDir, REPO_CONFIG_FILENAME),
    };
}

/**
 * Validate a parsed config. Returns every problem found, so `config check`
 * can list them all; an empty array means the file is well-formed.
 */
export function validateRepoConfig(raw: unknown): string[] {
    const problems: string[] = [];

    if (!isRecord(raw)) {
        return ["the file must contain a JSON object"];
    }

    if (raw.git === undefined) {
        return problems;
    }

    if (!isRecord(raw.git)) {
        return ["`git` must be an object"];
    }

    const git = raw.git;

    if (git.mainPrBranch !== undefined && (typeof git.mainPrBranch !== "string" || git.mainPrBranch.length === 0)) {
        problems.push("`git.mainPrBranch` must be a non-empty string");
    }

    if (git.branches === undefined) {
        return problems;
    }

    const branches: unknown[] | undefined = Array.isArray(git.branches) ? git.branches : undefined;

    if (!branches) {
        problems.push("`git.branches` must be an array");
        return problems;
    }

    branches.forEach((entry, index) => {
        const where = `git.branches[${index}]`;

        if (!isRecord(entry)) {
            problems.push(`${where} must be an object`);
            return;
        }

        const matchers = [
            typeof entry.name === "string" && entry.name.length > 0,
            typeof entry.nameRegex === "string" && entry.nameRegex.length > 0,
            entry.catchAll === true,
        ].filter(Boolean).length;

        if (matchers !== 1) {
            problems.push(`${where} needs exactly one of \`name\`, \`nameRegex\`, \`catchAll: true\``);
        }

        if (typeof entry.nameRegex === "string") {
            try {
                new RegExp(entry.nameRegex);
            } catch (err) {
                problems.push(
                    `${where}.nameRegex does not compile: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }

        if (entry.catchAll === true && index !== branches.length - 1) {
            problems.push(`${where} is \`catchAll\` but not the last entry; later entries could never match`);
        }

        if (entry.push !== undefined && !PUSH_POLICIES.includes(entry.push as PushPolicy)) {
            problems.push(`${where}.push must be one of ${PUSH_POLICIES.join(" | ")}`);
        }

        if (entry.deployDriver !== undefined && !DEPLOY_DRIVERS.includes(entry.deployDriver as DeployDriver)) {
            problems.push(`${where}.deployDriver must be one of ${DEPLOY_DRIVERS.join(" | ")}`);
        }

        if (entry.autoDeploys !== undefined && typeof entry.autoDeploys !== "boolean") {
            problems.push(`${where}.autoDeploys must be a boolean`);
        }

        if (entry.environment !== undefined && typeof entry.environment !== "string") {
            problems.push(`${where}.environment must be a string`);
        }
    });

    return problems;
}

/** Parse a file's text; a parse error becomes a problem, not an exception. */
export function parseRepoConfig(text: string, path: string): { config: RepoConfig; problems: string[] } {
    let raw: unknown;

    try {
        raw = SafeJSON.parse(text, { unbox: true });
    } catch (err) {
        return { config: {}, problems: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const problems = validateRepoConfig(raw);
    return { config: isRecord(raw) ? (raw as RepoConfig) : {}, problems };
}

/** Load the effective config for `cwd`; never throws on a bad file, see `problems`. */
export async function loadRepoConfig(cwd: string): Promise<LoadedRepoConfig> {
    const paths = await repoConfigPaths(cwd);
    const candidates: Array<{ source: RepoConfigSource; path: string }> = [
        { source: "claude", path: paths.claude },
        { source: "git-dir", path: paths.gitDir },
    ];

    for (const candidate of candidates) {
        if (!existsSync(candidate.path)) {
            continue;
        }

        const parsed = parseRepoConfig(readFileSync(candidate.path, "utf8"), candidate.path);
        logger.debug({ path: candidate.path, problems: parsed.problems }, "repo-config: loaded");
        return {
            config: parsed.config,
            source: candidate.source,
            path: candidate.path,
            problems: parsed.problems,
            paths,
        };
    }

    logger.debug({ claude: paths.claude, gitDir: paths.gitDir }, "repo-config: no file");
    return { config: {}, source: "none", path: null, problems: [], paths };
}

/** The policy for one branch: first matching entry top-down, `confirm` when nothing matches. */
export function branchPolicy(config: RepoConfig | undefined, branch: string): BranchPolicy {
    for (const entry of config?.git?.branches ?? []) {
        let matchedBy: BranchMatchedBy = "none";

        if (entry.name !== undefined) {
            matchedBy = entry.name === branch ? "name" : "none";
        } else if (entry.nameRegex !== undefined) {
            try {
                matchedBy = new RegExp(entry.nameRegex).test(branch) ? "nameRegex" : "none";
            } catch (err) {
                logger.debug({ err, nameRegex: entry.nameRegex }, "repo-config: skipping an invalid nameRegex");
            }
        } else if (entry.catchAll === true) {
            matchedBy = "catchAll";
        }

        if (matchedBy === "none") {
            continue;
        }

        return {
            push: entry.push ?? "confirm",
            environment: entry.environment,
            autoDeploys: entry.autoDeploys,
            deployDriver: entry.deployDriver,
            matchedBy,
        };
    }

    return { push: "confirm", matchedBy: "none" };
}

/** Declared branch names (exact `name` entries, in order); regex and catchAll entries are not names. */
export function declaredBranchNames(config: RepoConfig | undefined): string[] {
    return (config?.git?.branches ?? []).map((e) => e.name).filter((n): n is string => typeof n === "string");
}

export function formatRepoConfig(config: RepoConfig): string {
    return `${SafeJSON.stringify(config, null, 4)}\n`;
}

/** Write the local (common dir) copy; the `.claude/` copy is a versioned file people edit by hand. */
export async function writeLocalRepoConfig(cwd: string, config: RepoConfig): Promise<string> {
    const paths = await repoConfigPaths(cwd);
    writeFileSync(paths.gitDir, formatRepoConfig(config));
    logger.debug({ path: paths.gitDir }, "repo-config: wrote local config");
    return paths.gitDir;
}

export type MainBranchInference = "origin-head" | "remote-show" | "local";

export interface InferredMainBranch {
    branch: string;
    source: MainBranchInference;
}

/**
 * Guess the main branch when no config declares one: origin's HEAD first
 * (`refs/remotes/origin/HEAD`), then the remote's advertised HEAD, then a
 * local `master`/`main`. Printed by `config init`, because on repos whose PR
 * target is not origin's HEAD (a `feature/next` UAT branch, say) the guess is exactly
 * the mismatch the file exists to fix.
 */
export async function inferMainBranch(cwd: string): Promise<InferredMainBranch | null> {
    const git = createGit({ cwd }).executor;
    const symbolic = await git.exec(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);

    if (symbolic.success && symbolic.stdout) {
        return { branch: symbolic.stdout.replace(/^origin\//, ""), source: "origin-head" };
    }

    const hasOrigin = await git.exec(["remote", "get-url", "origin"]);

    if (hasOrigin.success) {
        try {
            const show = await git.exec(["remote", "show", "origin"], { timeout: 15_000 });
            const head = /HEAD branch:\s*(\S+)/.exec(show.stdout)?.[1];

            if (show.success && head && head !== "(unknown)") {
                return { branch: head, source: "remote-show" };
            }
        } catch (err) {
            logger.debug({ err }, "repo-config: git remote show origin failed");
        }
    }

    for (const candidate of ["master", "main"]) {
        const exists = await git.exec(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);

        if (exists.success) {
            return { branch: candidate, source: "local" };
        }
    }

    return null;
}
