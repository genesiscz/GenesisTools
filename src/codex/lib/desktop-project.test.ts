import { expect, test } from "bun:test";
import { assignThreadToProject, type CodexProject, projectForCwd } from "./desktop-project";

const PROJECTS: CodexProject[] = [
    { id: "p-home", name: "Martin", roots: [{ path: "/Users/fixture" }] },
    { id: "p-tools", name: "Tools", roots: [{ path: "/Users/fixture/Projects/Tools" }] },
    { id: "p-rewind", name: "Rewind", roots: [{ path: "/Users/fixture/Projects/Rewind" }] },
    { id: "p-rootless", name: "Rootless", roots: [] },
];

test("the deepest matching root wins, because the home directory is itself a project", () => {
    // Codex Desktop really does keep a project rooted at the home directory, and it contains
    // every other root, so a shallowest-first match would file everything under it.
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind")?.id).toBe("p-rewind");
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind/packages/ui")?.id).toBe("p-rewind");
    expect(projectForCwd(PROJECTS, "/Users/fixture/Downloads")?.id).toBe("p-home");
});

test("a sibling whose name merely starts the same is not a match", () => {
    expect(projectForCwd(PROJECTS, "/Users/fixture/Projects/Rewind-old")?.id).toBe("p-home");
    expect(projectForCwd([PROJECTS[2]], "/Users/fixture/Projects/Rewind-old")).toBeUndefined();
    expect(projectForCwd([], "/Users/fixture")).toBeUndefined();
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
    const project = await assignThreadToProject(api, { threadId: "t1", cwd: "/Users/fixture/Projects/Rewind" });

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
