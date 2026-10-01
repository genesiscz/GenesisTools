import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { parseStatusPorcelainV2Z } from "@genesiscz/utils/git/porcelain";
import { TransclusionError } from "../registry";
import type { TransclusionContext } from "../types";

/** A file bigger than this is refused instead of being read into memory for a few lines. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

const LANGUAGES: Record<string, string> = {
    ".ts": "ts",
    ".tsx": "tsx",
    ".mts": "ts",
    ".cts": "ts",
    ".js": "js",
    ".jsx": "jsx",
    ".mjs": "js",
    ".cjs": "js",
    ".json": "json",
    ".jsonc": "jsonc",
    ".md": "md",
    ".swift": "swift",
    ".py": "python",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".sh": "bash",
    ".zsh": "zsh",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
    ".css": "css",
    ".html": "html",
    ".vue": "vue",
    ".log": "text",
};

export function languageFor(path: string): string {
    return LANGUAGES[extname(path).toLowerCase()] ?? "";
}

/** Where a text came from, recorded on the token so a reader knows which version they see. */
export interface SourceProvenance {
    source: "commit" | "worktree" | "file";
    repoRoot?: string;
    /** The path relative to the repo root, when the file is in a repo. */
    repoPath?: string;
    /** The pinned commit (`commit=` given) or HEAD at save time (working tree). */
    sha?: string;
    /** True when the working-tree file differs from HEAD, so the lines may not exist in any commit. */
    dirty?: boolean;
    /** True when git does not track the file at all, so no commit has these lines. */
    untracked?: boolean;
}

export interface SourceText {
    text: string;
    provenance: SourceProvenance;
}

export async function git(
    args: string[],
    { cwd, ctx }: { cwd: string; ctx: TransclusionContext }
): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await ctx.run(["git", "--no-pager", ...args], {
        cwd,
        signal: ctx.signal,
        env: { GIT_PAGER: "cat" },
    });

    // A cut answer is never read as the whole one (a diff, a file at a commit).
    if (result.truncated) {
        throw new TransclusionError(`git ${args[0] ?? ""} printed more than ${formatMb(MAX_SOURCE_BYTES)}`);
    }

    return result;
}

/** The nearest existing folder at or above the path, so git runs even for a file only a commit has. */
function existingDir(path: string): string {
    let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);

    while (!existsSync(dir) && dirname(dir) !== dir) {
        dir = dirname(dir);
    }

    return dir;
}

/**
 * The path with symlinks in its existing part resolved (`/tmp` is `/private/tmp` on macOS), so it
 * compares with what `git rev-parse --show-toplevel` prints.
 */
export function realPath(path: string): string {
    let existing = path;

    while (!existsSync(existing) && dirname(existing) !== existing) {
        existing = dirname(existing);
    }

    return join(realpathSync(existing), relative(existing, path));
}

/** The path relative to the repo root, both sides with symlinks resolved. */
export function repoRelative(repoRoot: string, path: string): string {
    return relative(realPath(repoRoot), realPath(path));
}

export async function repoRootOf(path: string, ctx: TransclusionContext): Promise<string | null> {
    const result = await git(["rev-parse", "--show-toplevel"], { cwd: existingDir(path), ctx });
    return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * The text of a file, from a commit (`git show <sha>:<path>`, which pins what the reader sees) or
 * from the working tree with its provenance (HEAD sha and whether the file is dirty).
 */
export async function readSource({
    path,
    commit,
    ctx,
}: {
    path: string;
    commit?: string;
    ctx: TransclusionContext;
}): Promise<SourceText> {
    if (commit) {
        return readAtCommit({ path, commit, ctx });
    }

    if (!existsSync(path)) {
        throw new TransclusionError(`file not found: ${path}`);
    }

    const stat = statSync(path);

    if (stat.isDirectory()) {
        throw new TransclusionError(`${path} is a folder, not a file`);
    }

    if (stat.size > MAX_SOURCE_BYTES) {
        throw new TransclusionError(`${path} is ${formatMb(stat.size)}; the limit is ${formatMb(MAX_SOURCE_BYTES)}`);
    }

    const text = await Bun.file(path).text();
    return { text, provenance: await worktreeProvenance(path, ctx) };
}

async function readAtCommit({
    path,
    commit,
    ctx,
}: {
    path: string;
    commit: string;
    ctx: TransclusionContext;
}): Promise<SourceText> {
    const repoRoot = await repoRootOf(path, ctx);

    if (!repoRoot) {
        throw new TransclusionError(`commit="${commit}" needs a git repository, and ${path} is not in one`);
    }

    const sha = await git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: repoRoot, ctx });

    if (sha.code !== 0) {
        throw new TransclusionError(`unknown commit "${commit}" in ${repoRoot}`);
    }

    const repoPath = repoRelative(repoRoot, path);
    const shown = await git(["show", `${sha.stdout.trim()}:${repoPath}`], { cwd: repoRoot, ctx });

    if (shown.code !== 0) {
        throw new TransclusionError(`${repoPath} does not exist at ${commit}: ${firstLine(shown.stderr)}`);
    }

    return {
        text: shown.stdout,
        provenance: { source: "commit", repoRoot, repoPath, sha: sha.stdout.trim() },
    };
}

export async function worktreeProvenance(path: string, ctx: TransclusionContext): Promise<SourceProvenance> {
    const repoRoot = await repoRootOf(path, ctx);

    if (!repoRoot) {
        return { source: "file" };
    }

    const repoPath = repoRelative(repoRoot, path);
    const [head, status] = await Promise.all([
        git(["rev-parse", "HEAD"], { cwd: repoRoot, ctx }),
        git(["status", "--porcelain=v2", "-z", "--", repoPath], { cwd: repoRoot, ctx }),
    ]);
    // The shared typed reader, not a hand-parsed porcelain line.
    const entries = status.code === 0 ? parseStatusPorcelainV2Z(status.stdout).entries : null;

    return {
        source: "worktree",
        repoRoot,
        repoPath,
        ...(head.code === 0 ? { sha: head.stdout.trim() } : {}),
        ...(entries ? { dirty: entries.some((entry) => entry.kind !== "ignored") } : {}),
        ...(entries?.some((entry) => entry.kind === "untracked") ? { untracked: true } : {}),
    };
}

/** The caption line above a code block: the path, the lines, and where the text came from. */
export function caption({
    path,
    provenance,
    suffix,
}: {
    path: string;
    provenance: SourceProvenance;
    suffix?: string;
}): string {
    return `\`${provenance.repoPath ?? path}${suffix ? `:${suffix}` : ""}\``;
}

/**
 * The exact identity of a file read, for the provenance footer: `src/a.ts@545308d99` for a pinned
 * commit, `src/a.ts@HEAD 545308d99, uncommitted changes` for the working tree, the path otherwise.
 */
export function sourceIdentity({ path, provenance }: { path: string; provenance: SourceProvenance }): string {
    const shown = provenance.repoPath ?? path;
    const sha = provenance.sha?.slice(0, 9) ?? "unknown";

    if (provenance.source === "commit") {
        return `${shown}@${sha}`;
    }

    if (provenance.source === "worktree") {
        const state = provenance.untracked ? ", untracked" : provenance.dirty ? ", uncommitted changes" : "";
        return `${shown}@HEAD ${sha}${state}`;
    }

    return shown;
}

/** A fenced block whose fence is longer than any backtick run inside it. */
export function codeBlock({ text, lang, title }: { text: string; lang?: string; title?: string }): string {
    const longest = Math.max(2, ...(text.match(/^ {0,3}`{3,}/gm) ?? []).map((run) => run.trim().length));
    const fence = "`".repeat(longest + 1);
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return `${title ? `${title}\n` : ""}${fence}${lang ?? ""}\n${body}\n${fence}`;
}

export function splitLines(text: string): string[] {
    const lines = text.split("\n");

    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    return lines;
}

export function firstLine(text: string): string {
    return text.trim().split("\n")[0] ?? "";
}

function formatMb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function provenanceMeta(provenance: SourceProvenance): Record<string, unknown> {
    return { ...provenance };
}
