import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { createGit, getCurrentBranch, type NumstatEntry, originDriver, type PrInfo } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import {
    isReviewEffort,
    manifestChangedLines,
    REVIEW_EFFORTS,
    type ReviewEffort,
    type ReviewManifest,
} from "@genesiscz/utils/worker/contract";
import type { CodexReviewConfig, ReviewBaseSource } from "./types";

const log = logger.child({ component: "codex:review" });

/** A diff up to this size gets `high` by default; anything larger gets `xhigh`. */
export const HIGH_TIER_MAX = { files: 15, lines: 800 } as const;
/** Above either bound one reviewer is too thin, and the spawn proposes a split by folder. */
export const SPLIT_THRESHOLD = { files: 60, lines: 4000 } as const;

/** Everything the review preparation reads from git and the hosting service; injected so tests never spawn. */
export interface ReviewGitReaders {
    currentBranch(cwd: string): Promise<string | null>;
    /** `origin/<name>` when it exists, else the local branch, else null. */
    resolveBranch(cwd: string, name: string): Promise<string | null>;
    refExists(cwd: string, ref: string): Promise<boolean>;
    /** The newest PR of the branch; null when there is none or the host cannot answer. */
    pullRequest(cwd: string, branch: string): Promise<PrInfo | null>;
    upstream(cwd: string, branch: string): Promise<string | null>;
    /** `git diff --numstat <base>...<head>` (head defaults to HEAD), limited to `paths` when given. */
    numstat(cwd: string, base: string, paths?: string[], head?: string): Promise<NumstatEntry[]>;
    /** The newest commit of HEAD's history committed at or before `at` (ISO time); null when there is none. */
    commitBefore(cwd: string, at: string): Promise<string | null>;
}

export function defaultReviewGitReaders(): ReviewGitReaders {
    return {
        currentBranch: (cwd) => getCurrentBranch(cwd),
        async resolveBranch(cwd, name) {
            const git = createGit({ cwd });
            const short = name.replace(/^origin\//, "");

            if (await git.refExists(`refs/remotes/origin/${short}`)) {
                return `origin/${short}`;
            }

            return (await git.refExists(`refs/heads/${short}`)) ? short : null;
        },
        refExists: (cwd, ref) => createGit({ cwd }).refExists(`${ref}^{commit}`),
        async pullRequest(cwd, branch) {
            const driver = await originDriver(cwd);

            if (!driver) {
                return null;
            }

            const lookup = await driver.prForHead(branch);

            if (lookup.error) {
                log.debug({ branch, error: lookup.error }, "review: PR lookup failed");
            }

            return lookup.pr;
        },
        upstream: (cwd, branch) => createGit({ cwd }).getTrackingBranch(branch),
        async numstat(cwd, base, paths, head = "HEAD") {
            const git = createGit({ cwd });
            const mergeBase = await git.mergeBase(base, head);
            return git.numstat({ from: mergeBase, to: head, ...(paths?.length ? { paths } : {}) });
        },
        async commitBefore(cwd, at) {
            const result = await createGit({ cwd }).executor.exec([
                "log",
                "-1",
                "--format=%H",
                `--before=${at}`,
                "HEAD",
            ]);
            return result.success && result.stdout ? result.stdout : null;
        },
    };
}

export interface PrepareReviewInput {
    cwd: string;
    base?: string;
    effort?: string;
    allowShallow?: boolean;
    /** Limit the manifest to these paths: one slice of a split review. */
    paths?: string[];
    readers?: ReviewGitReaders;
}

export interface PreparedReview {
    /** The session's review record, without the chain fields the spawn adds. */
    config: Omit<CodexReviewConfig, "chain" | "step">;
    /** Lines the spawn prints as information: which base and why, which tier and why. */
    notes: string[];
    /** Lines the spawn prints as warnings: the split suggestion. */
    warnings: string[];
}

export interface ChosenBase {
    ref: string;
    source: ReviewBaseSource;
    detail: string;
    pr?: PrInfo;
}

/** The base ladder of `--mode review`: the flag (verified), else the branch's PR target, else its upstream. */
export async function chooseBase(
    input: Pick<PrepareReviewInput, "cwd" | "base"> & { readers: ReviewGitReaders; branch: string | null }
): Promise<ChosenBase> {
    const { readers, cwd, branch } = input;

    if (input.base) {
        if (!(await readers.refExists(cwd, input.base))) {
            throw new Error(
                `--base ${input.base} does not resolve in ${cwd}; run git fetch first or pick another ref.`
            );
        }

        const pr = branch ? await readers.pullRequest(cwd, branch) : null;
        return { ref: input.base, source: "flag", detail: "--base", ...(pr ? { pr } : {}) } satisfies ChosenBase;
    }

    if (!branch) {
        throw new Error("--mode review needs --base <ref>: HEAD is detached, so there is no PR or upstream to read.");
    }

    const pr = await readers.pullRequest(cwd, branch);

    if (pr) {
        const ref = await readers.resolveBranch(cwd, pr.target);

        if (ref) {
            return {
                ref,
                source: "pr",
                detail: `${pr.state} PR #${pr.number} targets ${pr.target}`,
                pr,
            } satisfies ChosenBase;
        }

        log.debug({ branch, pr }, "review: PR target does not resolve locally");
    }

    const upstream = await readers.upstream(cwd, branch);

    // A branch tracking its own remote copy has no base there: the diff against it is the unpushed commits only.
    if (upstream && upstream !== `origin/${branch}` && upstream !== branch) {
        return { ref: upstream, source: "upstream", detail: `upstream of ${branch}` } satisfies ChosenBase;
    }

    throw new Error(
        `--mode review needs --base <ref>: ${branch} has no PR whose target resolves and no upstream other than itself. \`${toolCommand("git base")}\` names a likely base.`
    );
}

export function buildManifest(base: string, entries: readonly NumstatEntry[]): ReviewManifest {
    const files = entries.map((entry) => ({
        path: entry.path,
        added: entry.insertions,
        deleted: entry.deletions,
        ...(entry.binary ? { binary: true } : {}),
    }));

    return {
        base,
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    };
}

/** `high` for a diff of up to 15 files and 800 changed lines, `xhigh` above that. */
export function defaultReviewEffort(manifest: ReviewManifest): ReviewEffort {
    const small = manifest.files.length <= HIGH_TIER_MAX.files && manifestChangedLines(manifest) <= HIGH_TIER_MAX.lines;
    return small ? "high" : "xhigh";
}

function chooseEffort(
    flag: string | undefined,
    allowShallow: boolean,
    manifest: ReviewManifest
): { effort: ReviewEffort; source: "flag" | "diff-size" } {
    if (flag === undefined) {
        return { effort: defaultReviewEffort(manifest), source: "diff-size" };
    }

    if (!isReviewEffort(flag)) {
        throw new Error(`--effort for a review must be one of ${REVIEW_EFFORTS.join(", ")}; got ${flag}.`);
    }

    if ((flag === "low" || flag === "medium") && !allowShallow) {
        throw new Error(
            `--effort ${flag} is refused for a review: medium reviews spent 358 to 2,399 reasoning tokens whatever the diff size and missed defects the xhigh pass found. Omit --effort to pick high or xhigh from the diff size, or pass --allow-shallow to accept a shallow review.`
        );
    }

    return { effort: flag, source: "flag" };
}

export interface ManifestSlice {
    folder: string;
    files: number;
    added: number;
    deleted: number;
}

function folderOf(path: string, depth: number): string {
    const parts = path.split("/");
    return parts.length > depth ? parts.slice(0, depth).join("/") : parts.slice(0, -1).join("/") || ".";
}

/**
 * One slice per folder, split deeper until each slice is at or under the file threshold or cannot split
 * further. A repo with everything under `src/` would otherwise get one useless `src` slice.
 */
export function splitManifest(manifest: ReviewManifest, depth = 1): ManifestSlice[] {
    const groups = new Map<string, ReviewManifest["files"]>();

    for (const file of manifest.files) {
        const folder = folderOf(file.path, depth);
        groups.set(folder, [...(groups.get(folder) ?? []), file]);
    }

    return [...groups.entries()]
        .flatMap(([folder, files]) => {
            const deeper = files.some((file) => file.path.split("/").length > depth + 1);

            if (files.length > SPLIT_THRESHOLD.files && deeper) {
                const sub = splitManifest({ ...manifest, files }, depth + 1);

                if (sub.length > 1) {
                    return sub;
                }
            }

            return [
                {
                    folder,
                    files: files.length,
                    added: files.reduce((sum, file) => sum + file.added, 0),
                    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
                },
            ];
        })
        .sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder));
}

export function splitSuggestion(manifest: ReviewManifest): string | null {
    const lines = manifestChangedLines(manifest);

    if (manifest.files.length <= SPLIT_THRESHOLD.files && lines <= SPLIT_THRESHOLD.lines) {
        return null;
    }

    // A diff under one folder (`src/`) only splits a level or two down.
    let depth = 1;
    let slices = splitManifest(manifest, depth);

    while (slices.length < 2 && depth < 4) {
        depth += 1;
        slices = splitManifest(manifest, depth);
    }

    if (slices.length < 2) {
        return null;
    }

    const listed = slices
        .slice(0, 12)
        .map((slice) => `${slice.folder} (${slice.files} files, +${slice.added} -${slice.deleted})`)
        .join(", ");
    const more = slices.length > 12 ? `, +${slices.length - 12} more` : "";

    return `${manifest.files.length} files, ${lines} changed lines: above about ${SPLIT_THRESHOLD.files} files or ${SPLIT_THRESHOLD.lines} lines one reviewer covers the diff thinly. Split suggestion, one reviewer per folder at xhigh, in parallel: ${listed}${more}. Each one: ${toolCommand("codex spawn")} --mode review --base ${manifest.base} --paths <folder> --name <name>-<folder>.`;
}

/**
 * Everything `spawn --mode review` decides before a worker starts: the base (the flag, else the branch's PR
 * target, else its upstream, and the notes say which), the manifest from `git diff --numstat <base>...HEAD`,
 * the tier (the flag, else the diff size) and the split suggestion for a large diff.
 */
export async function prepareReview(input: PrepareReviewInput): Promise<PreparedReview> {
    const readers = input.readers ?? defaultReviewGitReaders();
    const allowShallow = input.allowShallow === true;
    const branch = await readers.currentBranch(input.cwd);
    const base = await chooseBase({ ...input, readers, branch });
    const manifest = buildManifest(base.ref, await readers.numstat(input.cwd, base.ref, input.paths));

    if (manifest.files.length === 0) {
        throw new Error(
            `Nothing to review: git diff --numstat ${base.ref}...HEAD is empty in ${input.cwd}${input.paths?.length ? ` for ${input.paths.join(", ")}` : ""}.`
        );
    }

    const { effort, source } = chooseEffort(input.effort, allowShallow, manifest);
    const warnings = [splitSuggestion(manifest)].filter((line): line is string => line !== null);
    const notes = [
        `review base ${base.ref} (${base.source}: ${base.detail})`,
        `review manifest ${manifest.files.length} files, +${manifest.added} -${manifest.deleted}; effort ${effort} (${source === "flag" ? "--effort" : "from the diff size"})`,
    ];
    log.debug(
        { cwd: input.cwd, base: base.ref, source: base.source, files: manifest.files.length, effort },
        "review prepared"
    );

    return {
        config: {
            base: base.ref,
            baseSource: base.source,
            baseDetail: base.detail,
            ...(branch ? { branch } : {}),
            ...(base.pr ? { pr: base.pr.number } : {}),
            manifest,
            effort,
            effortSource: source,
            allowShallow,
        },
        notes,
        warnings,
    };
}
