import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import pc from "picocolors";
import { git } from "./recovery";

export type UpdateMode = "default" | "dev";

/**
 * `tools update dev` moves the checkout onto the newest enhancements-unified branch for a while;
 * the next plain `tools update` moves it back. The branch it came from is kept here, so a
 * checkout that was on the unified branch to begin with is never moved to master by surprise.
 */
export interface DevChannelState {
    branch: string;
    returnTo: string;
    since: string;
}

const UNIFIED_REF = /^origin\/(feat\/(\d{4}-\d{2}-\d{2})-enhancements-unified)$/;

/**
 * The child that runs the steps after the pull on the freshly pulled code. A variable, not a flag:
 * a child on code from before the hand-over (back from the dev channel onto an older master) would
 * refuse an unknown flag, while it simply ignores the variable and runs a whole update.
 */
export function postPullInvocation(opts: { plugins: boolean }): { args: string[]; env: Record<string, string> } {
    return {
        args: ["update", ...(opts.plugins ? [] : ["--no-plugins"])],
        env: { GENESIS_TOOLS_UPDATE_POST_PULL: "1" },
    };
}

function isUnifiedBranch(branch: string): boolean {
    return UNIFIED_REF.test(`origin/${branch}`);
}

export function devChannelPath(): string {
    return toolDataDir("update", "dev-channel.json");
}

/** The newest `origin/feat/<date>-enhancements-unified`, by the date in its name, as a local branch name. */
export function pickNewestUnifiedBranch(remoteRefs: string[]): string | undefined {
    let best: { branch: string; date: string } | undefined;

    for (const ref of remoteRefs) {
        const match = ref.trim().match(UNIFIED_REF);

        if (!match?.[1] || !match[2]) {
            continue;
        }

        if (!best || match[2] > best.date) {
            best = { branch: match[1], date: match[2] };
        }
    }

    return best?.branch;
}

export function readDevChannel(path = devChannelPath()): DevChannelState | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf-8"));

    if (
        typeof parsed === "object" &&
        parsed !== null &&
        "branch" in parsed &&
        "returnTo" in parsed &&
        typeof parsed.branch === "string" &&
        typeof parsed.returnTo === "string"
    ) {
        return {
            branch: parsed.branch,
            returnTo: parsed.returnTo,
            since: "since" in parsed && typeof parsed.since === "string" ? parsed.since : "",
        };
    }

    return undefined;
}

export function writeDevChannel(state: DevChannelState, path = devChannelPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${SafeJSON.stringify(state, null, 2)}\n`);
}

export function clearDevChannel(path = devChannelPath()): void {
    if (existsSync(path)) {
        unlinkSync(path);
    }
}

/**
 * Moves the checkout onto or off the dev channel before the pull.
 *
 * "pull": go on with `git pull` on the current branch. "at-tip": the checkout already sits on the
 * freshly fetched dev branch, so there is nothing to pull. "failed": the reason is printed.
 */
export async function switchChannel(
    cwd: string,
    mode: UpdateMode,
    statePath = devChannelPath()
): Promise<"pull" | "at-tip" | "failed"> {
    const state = readDevChannel(statePath);

    if (mode === "default") {
        if (!state) {
            return "pull";
        }

        if (!(await workingTreeIsClean(cwd))) {
            return "failed";
        }

        out.println(pc.dim(`  Leaving the dev channel (${state.branch}): back to ${state.returnTo}...`));
        const back = await git(["switch", state.returnTo], cwd);

        if (back.code !== 0) {
            out.error(pc.red(`  Could not switch back to ${state.returnTo}.`));
            out.println(pc.dim(`  ${back.output}`));
            return "failed";
        }

        clearDevChannel(statePath);
        return "pull";
    }

    out.println(pc.dim("  Fetching origin..."));
    const fetched = await git(["fetch", "origin", "--prune"], cwd);

    if (fetched.code !== 0) {
        out.error(pc.red("  git fetch failed."));
        out.println(pc.dim(`  ${fetched.output}`));
        return "failed";
    }

    const refs = await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/feat/"], cwd);
    const branch = pickNewestUnifiedBranch(refs.output.split("\n"));

    if (!branch) {
        out.error(pc.red("  origin has no feat/<date>-enhancements-unified branch."));
        return "failed";
    }

    if (!(await workingTreeIsClean(cwd))) {
        return "failed";
    }

    // `switch -C` resets a local branch of that name onto origin's tip. Commits that exist only
    // locally would be lost, so they stop the switch instead.
    const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);

    if (local.code === 0) {
        const ahead = await git(["rev-list", "--count", `origin/${branch}..${branch}`], cwd);

        if (Number(ahead.output) > 0) {
            out.error(pc.red(`  ${branch} has ${ahead.output} local commit(s) that are not on origin.`));
            out.println(pc.dim("  Push them or move them to another branch, then run this again."));
            return "failed";
        }
    }

    const current = (await git(["branch", "--show-current"], cwd)).output;
    // A checkout switched to a unified branch by hand (the first switch from code that predates
    // `tools update dev`) has no record yet; returning to that same branch would never leave it.
    const returnTo = state?.returnTo ?? (current && !isUnifiedBranch(current) ? current : "master");
    const switched = await git(["switch", "--no-track", "-C", branch, `origin/${branch}`], cwd);

    if (switched.code !== 0) {
        out.error(pc.red(`  Could not switch to ${branch}.`));
        out.println(pc.dim(`  ${switched.output}`));
        return "failed";
    }

    writeDevChannel({ branch, returnTo, since: new Date().toISOString() }, statePath);
    out.println(pc.yellow(`  On ${branch} (dev channel). The next ${toolCommand("update")} returns to ${returnTo}.`));
    return "at-tip";
}

/** Tracked changes would block `git switch` halfway, so the channel switch refuses them up front. */
async function workingTreeIsClean(cwd: string): Promise<boolean> {
    const status = await git(["status", "--porcelain", "--untracked-files=no"], cwd);

    if (status.code === 0 && status.output === "") {
        return true;
    }

    out.error(pc.red("  The GenesisTools checkout has uncommitted changes; commit or stash them first:"));
    out.println(pc.dim(`  ${status.output.split("\n").slice(0, 10).join("\n  ")}`));
    return false;
}
