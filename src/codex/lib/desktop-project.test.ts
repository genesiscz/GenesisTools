import { expect, test } from "bun:test";
import { assignThreadToProject, type CodexProject, projectForCwd, resolveProjectSelector } from "./desktop-project";

const PROJECTS: CodexProject[] = [
    { id: "p-home", name: "Martin", roots: [{ path: "/Users/fixture" }] },
    { id: "p-tools", name: "Tools", roots: [{ path: "/Users/fixture/Projects/Tools" }] },
    { id: "p-rewind", name: "Rewind", roots: [{ path: "/Users/fixture/Projects/Rewind" }] },
    { id: "p-rootless", name: "Rootless", roots: [] },
];

const HOME = "/Users/fixture";

test("the deepest matching root wins", () => {
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind", HOME)?.id).toBe("p-rewind");
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind/packages/ui", HOME)?.id).toBe("p-rewind");
});

test("a project rooted at the home directory is never used, even as a last resort", () => {
    // It matches every cwd, so it files threads whose real project does not exist yet under a
    // catch-all — and `thread/metadata/update` cannot clear a projectId, so undoing that is
    // manual. A backfill put four unrelated threads under `Martin` on 2026-09-11 this way.
    expect(projectForCwd(PROJECTS, "/Users/fixture/Downloads", HOME)).toBeUndefined();
    expect(projectForCwd(PROJECTS, "/Users/fixture", HOME)).toBeUndefined();
});

test("a sibling whose name merely starts the same is not a match", () => {
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind-old", HOME)).toBeUndefined();
    expect(projectForCwd([PROJECTS[2]], "/Users/fixture/Projects/Rewind-old", HOME)).toBeUndefined();
    expect(projectForCwd([], "/Users/fixture", HOME)).toBeUndefined();
});

test("--project names a project by id, by name in any case, or by a directory inside one of its roots", () => {
    expect(resolveProjectSelector(PROJECTS, "p-rewind", HOME).id).toBe("p-rewind");
    expect(resolveProjectSelector(PROJECTS, "tools", HOME).id).toBe("p-tools");
    expect(resolveProjectSelector(PROJECTS, "/Users/fixture/Projects/Rewind/packages", HOME).id).toBe("p-rewind");
    expect(resolveProjectSelector(PROJECTS, "~/Projects/Tools", HOME).id).toBe("p-tools");
});

test("--project refuses a name two projects share, and an unknown one, with the choices", () => {
    // Desktop allows duplicate names; picking one would file the thread where the user does not look.
    const twins = [...PROJECTS, { id: "p-tools-2", name: "Tools", roots: [{ path: "/Users/fixture/Other" }] }];

    expect(() => resolveProjectSelector(twins, "Tools", HOME)).toThrow("p-tools, p-tools-2");
    expect(() => resolveProjectSelector(PROJECTS, "Nope", HOME)).toThrow("Projects: Martin, Rewind, Rootless, Tools");
    expect(() => resolveProjectSelector(PROJECTS, "/elsewhere", HOME)).toThrow(
        'No Codex Desktop project matches "/elsewhere"'
    );
});

test("a chosen project wins over the one that owns the directory, and needs no project lookup", async () => {
    // Two projects can hold the same worktree; the caller's choice is the only way to say which one.
    const api = client([{ id: "t1", projectId: null }]);
    const chosen = PROJECTS[1];
    const project = await assignThreadToProject(api, {
        threadId: "t1",
        cwd: "/Users/fixture/Projects/Rewind",
        home: HOME,
        project: chosen,
    });

    expect(project?.id).toBe("p-tools");
    expect(api.calls.map((call) => call.method)).toEqual(["thread/list", "thread/metadata/update"]);
    expect(updates(api.calls)[0]?.params).toEqual({ threadId: "t1", projectId: "p-tools" });
});

test("a chosen project still never moves a thread the user filed", async () => {
    const api = client([{ id: "t1", projectId: "p-rewind" }]);

    expect(await assignThreadToProject(api, { threadId: "t1", cwd: "/x", home: HOME, project: PROJECTS[1] })).toBe(
        undefined
    );
    expect(updates(api.calls)).toEqual([]);
});

function client(threads: Array<{ id: string; projectId?: string | null }>) {
    const calls: Array<{ method: string; params: unknown }> = [];

    return {
        calls,
        request: async <T>(method: string, params?: unknown): Promise<T> => {
            calls.push({ method, params });

            if (method === "thread/list") {
                return { data: threads } as T;
            }

            if (method === "project/list") {
                return { data: PROJECTS } as T;
            }

            return {} as T;
        },
    };
}

const updates = (calls: Array<{ method: string; params: unknown }>) =>
    calls.filter((call) => call.method === "thread/metadata/update");

test("an unfiled thread is put under the project that owns its directory", async () => {
    const api = client([{ id: "t1", projectId: null }]);
    const project = await assignThreadToProject(api, {
        threadId: "t1",
        cwd: "/Users/fixture/Projects/Rewind",
        home: HOME,
    });

    expect(project?.id).toBe("p-rewind");
    expect(updates(api.calls)).toEqual([
        { method: "thread/metadata/update", params: { threadId: "t1", projectId: "p-rewind" } },
    ]);
});

test("a thread the user already filed is never moved", async () => {
    // Overwriting this would silently reorganise the sidebar on every resume.
    const api = client([{ id: "t1", projectId: "p-tools" }]);

    expect(await assignThreadToProject(api, { threadId: "t1", cwd: "/Users/fixture/Projects/Rewind" })).toBeUndefined();
    expect(updates(api.calls)).toEqual([]);
});

test("nothing is written when the thread is not in the page or no project owns the directory", async () => {
    const missing = client([{ id: "other", projectId: null }]);
    expect(
        await assignThreadToProject(missing, { threadId: "t1", cwd: "/Users/fixture/Projects/Rewind" })
    ).toBeUndefined();
    expect(updates(missing.calls)).toEqual([]);

    const outside = client([{ id: "t1", projectId: null }]);
    expect(await assignThreadToProject(outside, { threadId: "t1", cwd: "/elsewhere" })).toBeUndefined();
    expect(updates(outside.calls)).toEqual([]);
});
/**
 * A linked worktree is a SIBLING of the checkout (`…/Tools.worktrees/x` beside `…/Tools`), so a
 * project rooted at the checkout never contains it. Four real threads started in worktrees
 * matched nothing on 2026-09-11 and fell into a catch-all project.
 */
test("a thread started in a worktree is filed under the main checkout's project", async () => {
    const worktree = "/Users/fixture/Projects/Tools.worktrees/feature-x";
    const api = client([{ id: "t1", projectId: null }]);
    const project = await assignThreadToProject(api, {
        threadId: "t1",
        cwd: worktree,
        home: HOME,
        // Injected: the real resolver shells out to git, and the fixture path is not a repo.
        mainCheckout: "/Users/fixture/Projects/Tools",
    });

    expect(project?.id).toBe("p-tools");
});

/**
 * The `mainCheckout === cwd` guard beside the fallback is a redundant-work short-circuit:
 * `projectForCwd` is pure over the same arguments, so skipping the second call cannot change
 * the answer, and no black-box test can tell the guarded and unguarded forms apart. What is
 * worth pinning is the pair of outcomes for a cwd that is its own checkout.
 */
test("a cwd that is its own checkout resolves from the first lookup", async () => {
    const api = client([{ id: "t1", projectId: null }]);
    const project = await assignThreadToProject(api, {
        threadId: "t1",
        cwd: "/Users/fixture/Projects/Rewind",
        home: HOME,
        mainCheckout: "/Users/fixture/Projects/Rewind",
    });

    expect(project?.id).toBe("p-rewind");
});

test("a cwd that is its own checkout and belongs to no project writes nothing", async () => {
    const api = client([{ id: "t1", projectId: null }]);

    expect(
        await assignThreadToProject(api, {
            threadId: "t1",
            cwd: "/elsewhere",
            home: HOME,
            mainCheckout: "/elsewhere",
        })
    ).toBeUndefined();
    expect(updates(api.calls)).toEqual([]);
});
