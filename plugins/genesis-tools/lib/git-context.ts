/**
 * "Which project, which branch, which checkout am I in?", shared by every plugin skill that
 * resolves an output path from the repo it is standing in.
 *
 * Both wrap-up and research answer the same question and must answer it the same way. The
 * failure mode they share is a confident wrong answer rather than a missing one: the agent's
 * shell cwd survives across calls and is not necessarily the repo the session worked in, and a
 * branch read from the main checkout is not the branch of the linked worktree where the work
 * actually happened.
 *
 * Standalone by design: no imports outside node builtins and Bun, because plugin scripts run
 * under bare `bun <path>`.
 */

import { basename } from "node:path";
import { expandHome } from "./plugin-config.ts";

export interface Worktree {
    dir: string;
    branch: string;
}

export interface Ctx {
    toplevel: string;
    branch: string;
    cwd: string;
    /** The main checkout, when `toplevel` is a linked worktree. Empty otherwise. */
    mainProject?: string;
    /** Every checkout of this repo, main first, as git reports them. */
    worktrees?: Worktree[];
    /** Which parts of the context the caller pinned, rather than the ambient shell. */
    pinned?: { project: boolean; branch: boolean };
}

export async function sh(cmd: string[], label = "git-context"): Promise<string> {
    try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const code = await proc.exited;

        if (code !== 0) {
            // Callers deliberately fall back (cwd / empty branch) so this stays non-fatal, but a
            // swallowed failure is indistinguishable from a legitimately empty result.
            console.error(`${label}: \`${cmd.join(" ")}\` exited ${code}${err.trim() ? `: ${err.trim()}` : ""}`);

            // Discard whatever landed on stdout: a failed `git rev-parse` can still print, and
            // passing that through would be taken for a real toplevel or branch name.
            return "";
        }

        return out.trim();
    } catch (err) {
        // Bun.spawn throws outright when the binary is missing from $PATH, which would crash the
        // command instead of taking the documented no-git fallback.
        console.error(`${label}: \`${cmd.join(" ")}\` could not run: ${String(err)}`);

        return "";
    }
}

/**
 * First porcelain `worktree ` line is the main checkout. Empty or same-path means we ARE the
 * main checkout, or git said nothing.
 */
export function parsePorcelainMain(text: string, toplevel: string): string {
    const first = text.split("\n")[0] ?? "";
    const main = first.startsWith("worktree ") ? first.slice("worktree ".length).trim() : "";

    return main && main !== toplevel ? main : "";
}

/**
 * Every checkout with the branch it has out.
 *
 * The branch alone is not the session's branch: run from the main checkout, `rev-parse HEAD`
 * answers for the main checkout even when the work happened in a linked worktree on another
 * branch. Knowing the siblings is what lets a resolver say so instead of resolving confidently
 * to the wrong target.
 */
export function parsePorcelainWorktrees(text: string): Worktree[] {
    const list: Worktree[] = [];

    for (const line of text.split("\n")) {
        if (line.startsWith("worktree ")) {
            list.push({ dir: line.slice("worktree ".length).trim(), branch: "" });
            continue;
        }

        const current = list[list.length - 1];

        if (line.startsWith("branch ") && current) {
            current.branch = line
                .slice("branch ".length)
                .trim()
                .replace(/^refs\/heads\//, "");
            continue;
        }

        if (line.trim() === "detached" && current) {
            current.branch = "detached";
        }
    }

    return list.filter((entry) => entry.dir);
}

/**
 * Everything keys off this context, so taking it from the ambient shell alone is how output
 * lands in another project's folder. `--project` / `--branch` / `--cwd` pin it, and the pinned
 * values are echoed back so a wrong one is visible instead of silent.
 */
export async function gitContext(args: Record<string, string> = {}, label = "git-context"): Promise<Ctx> {
    const pinnedProject = args.project ? expandHome(args.project) : "";
    // A pinned project implies its own cwd: keeping the ambient one would let a stale directory
    // still path-match a foreign entry.
    const cwd = args.cwd ? expandHome(args.cwd) : pinnedProject || process.cwd();
    // Normalize whatever was pinned to the checkout root. --project is routinely given a
    // subdirectory or a worktree path, and echoing that raw path back as "project" is how a
    // wrong target survives review.
    const toplevel = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"], label)) || pinnedProject || cwd;
    const branch = args.branch || (await sh(["git", "-C", toplevel, "rev-parse", "--abbrev-ref", "HEAD"], label));
    const porcelain = await sh(["git", "-C", toplevel, "worktree", "list", "--porcelain"], label);

    return {
        toplevel,
        branch: branch || "",
        cwd,
        mainProject: parsePorcelainMain(porcelain, toplevel),
        worktrees: parsePorcelainWorktrees(porcelain),
        pinned: { project: Boolean(args.project), branch: Boolean(args.branch) },
    };
}

/**
 * The branch is an assumption whenever it came from the ambient shell.
 *
 * Run from the main checkout, `rev-parse HEAD` reports the main checkout's branch even when the
 * session worked in a linked worktree on a different one, so `feature/next` gets resolved for
 * work that happened somewhere else entirely. Name the siblings rather than guessing.
 */
export function ambientBranchWarnings(ctx: Ctx): string[] {
    const siblings = (ctx.worktrees ?? []).filter((entry) => entry.dir !== ctx.toplevel);
    // Only the main checkout is ambiguous. Standing in a linked worktree, the cwd pins the
    // branch as surely as --branch would, so warning there is noise that trains the reader to
    // skip the line that matters.
    const inMain = !ctx.mainProject;

    if (ctx.pinned?.branch || !inMain || siblings.length === 0) {
        return [];
    }

    const listed = siblings
        .slice(0, 5)
        .map((entry) => `${basename(entry.dir)} (${entry.branch || "detached"})`)
        .join(", ");
    const more = siblings.length > 5 ? `, +${siblings.length - 5} more` : "";

    return [
        `branch "${ctx.branch}" was read from the MAIN checkout, not pinned: this repo has ${siblings.length} other checkout${siblings.length === 1 ? "" : "s"} — ${listed}${more}. If the session worked in one of those, pass --project/--branch or the output lands on the wrong branch's target`,
    ];
}
