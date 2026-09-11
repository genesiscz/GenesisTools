import { homedir } from "node:os";
import { resolve } from "node:path";
import { getMainRepoRootSync } from "@genesiscz/utils/git/worktree";
import { logger } from "@genesiscz/utils/logger";

/**
 * Putting a `tools codex run` thread under the Codex Desktop project that owns its directory.
 *
 * A thread with no project is filed under `projectless-thread-ids` in
 * `<home>/.codex-global-state.json`, and Desktop's sidebar is organised by project, so it
 * never appears. That is why `rewind-improvements` was missing from the app on 2026-09-11
 * while its rollout, its `threads` row and its name were all present and correct.
 *
 * The assignment goes through the app-server's own `project/list` and
 * `thread/metadata/update`, never by editing Desktop's JSON: that file belongs to a running
 * app, and `projectId` is the only field `thread/metadata/update` accepts anyway (verified
 * against codex 0.153.4 — `name`, `cwd`, `sectionId`, `archived` and `pinned` are all
 * rejected as unknown).
 */

export interface CodexProject {
    id: string;
    name: string;
    roots: Array<{ path: string }>;
}

interface ProjectClient {
    request<T>(method: string, params?: unknown): Promise<T>;
}

/**
 * The project whose root holds `cwd`, deepest root first.
 *
 * Depth matters because Codex Desktop keeps a project rooted at the home directory, which
 * contains every other root. Without the ordering every thread would land there.
 *
 * A root that IS the home directory is skipped entirely rather than used as a last resort.
 * It matches everything, so it files threads whose real project simply does not exist yet
 * under a catch-all the user then has to clean up — and `thread/metadata/update` cannot clear
 * a projectId (a null is read as "no field"), so that clean-up is manual. Observed
 * 2026-09-11: a backfill put four unrelated threads under `Martin` and they could not be
 * moved back out from the API.
 */
export function projectForCwd(
    projects: readonly CodexProject[],
    cwd: string,
    home: string = homedir()
): CodexProject | undefined {
    const target = resolve(cwd);
    const catchAll = resolve(home);
    let best: { project: CodexProject; depth: number } | undefined;

    for (const project of projects) {
        for (const root of project.roots ?? []) {
            const path = resolve(root.path);

            if (path === catchAll) {
                continue;
            }

            if (target !== path && !target.startsWith(`${path}/`)) {
                continue;
            }

            if (!best || path.length > best.depth) {
                best = { project, depth: path.length };
            }
        }
    }

    return best?.project;
}

/**
 * Assign the thread, unless it already belongs somewhere.
 *
 * A thread the user has filed by hand in Desktop is never moved: `thread/list` is read first
 * and a thread that already carries a `projectId` is left alone. When the thread cannot be
 * found in the recent page, nothing is written either — a wrong guess here silently reorganises
 * somebody's sidebar.
 */
export async function assignThreadToProject(
    client: ProjectClient,
    options: {
        threadId: string;
        cwd: string;
        limit?: number;
        home?: string;
        /** Injected by tests: the real resolver shells out to git, and a fixture path is no repo. */
        mainCheckout?: string;
    }
): Promise<CodexProject | undefined> {
    const { threadId, cwd } = options;
    const threads = await client.request<{ data?: Array<{ id?: string; projectId?: string | null }> }>("thread/list", {
        limit: options.limit ?? 20,
    });
    const current = threads.data?.find((thread) => thread.id === threadId);

    if (!current) {
        logger.debug({ threadId }, "[codex] thread is not in the recent page; leaving its project alone");
        return undefined;
    }

    if (current.projectId) {
        return undefined;
    }

    const projects = await client.request<{ data?: CodexProject[] }>("project/list", {});
    // A linked worktree lives BESIDE the repo, not inside it (`GenesisTools.worktrees/x` is a
    // sibling of `GenesisTools`), so a project rooted at the checkout never contains a worktree
    // cwd. Measured 2026-09-11: four threads started in worktrees matched nothing and fell to a
    // catch-all. The main checkout is the honest answer for them.
    const mainCheckout = options.mainCheckout ?? getMainRepoRootSync(cwd);
    const project =
        projectForCwd(projects.data ?? [], cwd, options.home) ??
        (mainCheckout === cwd ? undefined : projectForCwd(projects.data ?? [], mainCheckout, options.home));

    if (!project) {
        logger.debug({ threadId, cwd, mainCheckout }, "[codex] no Desktop project owns this directory");
        return undefined;
    }

    await client.request("thread/metadata/update", { threadId, projectId: project.id });
    logger.info({ threadId, project: project.name, projectId: project.id }, "[codex] thread filed under its project");

    return project;
}
