import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { reportMissingTodo, rerunWithProjectCommand, resolveProjectRoot, UNRECORDED_ROOT } from "../project";
import { TodoStore } from "../store";

/**
 * The store directory is a hash of the project root, so an id created under one
 * project is absent from every other cwd. `GENESIS_TOOLS_HOME` is redirected at
 * a temp dir for the whole file, so the default storage root resolves there and
 * the real store is never read or written.
 */
let SANDBOX: string;
let originalArgv: string[];

beforeEach(() => {
    SANDBOX = mkdtempSync(join(tmpdir(), "todo-project-test-"));
    env.testing.set("GENESIS_TOOLS_HOME", SANDBOX);
    originalArgv = process.argv;
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    process.argv = originalArgv;
    rmSync(SANDBOX, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
    it("makes a relative --project absolute", () => {
        expect(resolveProjectRoot("./some-dir")).toBe(join(process.cwd(), "some-dir"));
    });

    it("falls back to the cwd's project root when no flag is given", () => {
        expect(resolveProjectRoot(undefined)).toBeTruthy();
    });
});

describe("rerunWithProjectCommand", () => {
    it("appends --project to the command the caller just ran", () => {
        process.argv = ["bun", "index.ts", "sync", "todo_abc", "--to", "calendar"];

        expect(rerunWithProjectCommand("/tmp/other-proj")).toBe(
            "tools todo sync todo_abc --to calendar --project /tmp/other-proj"
        );
    });

    it("quotes a path with spaces", () => {
        process.argv = ["bun", "index.ts", "show", "todo_abc"];

        expect(rerunWithProjectCommand("/tmp/my proj")).toBe("tools todo show todo_abc --project '/tmp/my proj'");
    });

    it("neutralizes a command substitution instead of leaving it live inside double quotes", () => {
        process.argv = ["bun", "index.ts", "show", "todo_abc"];
        const projectRoot = "/tmp/$(touch pwned) proj";

        expect(rerunWithProjectCommand(projectRoot)).toBe(`tools todo show todo_abc --project '${projectRoot}'`);
    });

    it("replaces a --project that does not hold the id instead of echoing it back", () => {
        process.argv = ["bun", "index.ts", "show", "todo_abc", "--project", "/tmp/a"];

        expect(rerunWithProjectCommand("/tmp/b")).toBe("tools todo show todo_abc --project /tmp/b");
    });

    it("replaces the --project=<path> form too", () => {
        process.argv = ["bun", "index.ts", "show", "todo_abc", "--project=/tmp/a"];

        expect(rerunWithProjectCommand("/tmp/b")).toBe("tools todo show todo_abc --project=/tmp/b");
    });
});

describe("reportMissingTodo", () => {
    it("names the project that holds an id created under another root", async () => {
        const owner = join(SANDBOX, "owner-project");
        const other = join(SANDBOX, "other-project");
        const todo = await TodoStore.forProject(owner).add({ title: "call slot" });

        process.argv = ["bun", "index.ts", "sync", todo.id, "--to", "calendar"];
        const report = await reportMissingTodo(todo.id, other);

        expect(report.found?.projectRoot).toBe(owner);
        expect(report.lines[0]).toBe(`Todo not found in this project: ${todo.id}`);
        expect(report.lines.join("\n")).toContain(`id lives in:      ${owner}`);
        expect(report.lines.join("\n")).toContain(`--project ${owner}`);
    });

    it("says so plainly when no project holds the id", async () => {
        await TodoStore.forProject(join(SANDBOX, "owner-project")).add({ title: "unrelated" });

        const report = await reportMissingTodo("todo_missing", join(SANDBOX, "other-project"));

        expect(report.found).toBeNull();
        expect(report.lines[0]).toBe("Todo not found: todo_missing");
        expect(report.lines.join("\n")).toContain("No other project store holds this id");
    });
});

describe("cross-project store access", () => {
    it("reaches a todo created under --project from any cwd", async () => {
        const owner = join(SANDBOX, "owner-project");
        const created = await TodoStore.forProject(owner).add({ title: "shared work" });

        const reopened = await TodoStore.forProject(owner).get(created.id);
        const fromElsewhere = await TodoStore.forProject(join(SANDBOX, "other-project")).get(created.id);

        expect(reopened?.title).toBe("shared work");
        expect(fromElsewhere).toBeNull();
    });

    it("findTodo locates the id and its project root", async () => {
        const owner = join(SANDBOX, "owner-project");
        const created = await TodoStore.forProject(owner).add({ title: "locate me" });

        const located = await TodoStore.findTodo(created.id);

        expect(located?.todo.id).toBe(created.id);
        expect(located?.projectRoot).toBe(owner);
    });
});
describe("a store whose project root is unrecorded", () => {
    it("names the id as unrecorded instead of printing a blank path", async () => {
        const owner = join(SANDBOX, "owner-project");
        const todo = await TodoStore.forProject(owner).add({ title: "orphan" });
        const projectsDir = join(SANDBOX, ".genesis-tools", "todo", "projects");

        // Strip every trace of the owning root: no meta.json, and a todo that
        // carries no context of its own — the shape an import can leave behind.
        for (const entry of readdirSync(projectsDir)) {
            const dir = join(projectsDir, entry);
            if (!readdirSync(dir).includes("todos.json")) {
                continue;
            }

            const stored = SafeJSON.parse(readFileSync(join(dir, "todos.json"), "utf-8")) as Array<
                Record<string, unknown>
            >;

            if (!stored.some((t) => t.id === todo.id)) {
                continue;
            }

            writeFileSync(
                join(dir, "todos.json"),
                SafeJSON.stringify(
                    stored.map((t) => {
                        const { context: _context, ...rest } = t;
                        return rest;
                    }),
                    null,
                    2
                )
            );
            rmSync(join(dir, "meta.json"), { force: true });
        }

        const report = await reportMissingTodo(todo.id, join(SANDBOX, "other-project"));

        expect(report.found).not.toBeNull();
        expect(report.message).toContain(UNRECORDED_ROOT);
        expect(report.message).not.toContain("re-run with:");
        expect(report.message).not.toMatch(/id lives in: *$/m);
    });
});
