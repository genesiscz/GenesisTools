import { resolve } from "node:path";
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
 * Depth matters because `/Users/Martin` is itself one of the projects Desktop keeps, and it
 * contains every other root. Without the ordering every thread would land there.
 */
export function projectForCwd(projects: readonly CodexProject[], cwd: string): CodexProject | undefined {
    const target = resolve(cwd);
    let best: { project: CodexProject; depth: number } | undefined;

    for (const project of projects) {
        for (const root of project.roots ?? []) {
            const path = resolve(root.path);

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
    options: { threadId: string; cwd: string; limit?: number }
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
    const project = projectForCwd(projects.data ?? [], cwd);

    if (!project) {
        logger.debug({ threadId, cwd }, "[codex] no Desktop project owns this directory");
        return undefined;
    }

    await client.request("thread/metadata/update", { threadId, projectId: project.id });
    logger.info({ threadId, project: project.name, projectId: project.id }, "[codex] thread filed under its project");

    return project;
}
