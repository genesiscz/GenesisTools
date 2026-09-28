import { describe, expect, test } from "bun:test";
import {
    type ContextGatherer,
    type ContextTarget,
    defaultGatherers,
    gatherRepoContext,
    instructionFilesGatherer,
    projectsGatherer,
    type RepoContextReader,
    type RepoLookup,
    testCommandsGatherer,
} from "./index";

/** A tree in memory. `withheld` and `skipped` model a caller policy; reads are counted per path. */
function memoryReader(files: Record<string, string>, policy: { withheld?: string[]; skipDot?: boolean } = {}) {
    const reads = new Map<string, number>();
    const reader: RepoContextReader = {
        async lookup(path): Promise<RepoLookup> {
            if (policy.skipDot && path.split("/").some((part) => part.startsWith("."))) {
                return "skipped";
            }

            if (policy.withheld?.includes(path)) {
                return "withheld";
            }

            return path in files ? "file" : "missing";
        },
        async readText(path) {
            reads.set(path, (reads.get(path) ?? 0) + 1);
            return files[path];
        },
    };
    return { reader, reads };
}

function target(path: string, shownRanges: ContextTarget["shownRanges"] = [], roles: string[] = []): ContextTarget {
    return { path, roles, shownRanges };
}

const TS_TEST = 'import { test } from "vitest";\n\ntest("totals", () => {\n    expect(1).toBe(1);\n});\n';

describe("instruction files", () => {
    test("root and target ancestors only, root first, dot names skipped without marking the list short", async () => {
        const { reader } = memoryReader(
            { "AGENTS.md": "", "CLAUDE.md": "", "web/CLAUDE.md": "", "web/src/app.ts": "", "other/AGENTS.md": "" },
            { skipDot: true }
        );
        const { results } = await gatherRepoContext({
            reader,
            targets: [target("web/src/app.ts")],
            gatherers: [instructionFilesGatherer()],
        });
        expect(results.instructions).toEqual({ files: ["AGENTS.md", "CLAUDE.md", "web/CLAUDE.md"], incomplete: false });
    });

    test("a withheld guidance file makes the list incomplete", async () => {
        const { reader } = memoryReader({ "AGENTS.md": "" }, { withheld: ["CLAUDE.md"] });
        const { results } = await gatherRepoContext({ reader, targets: [], gatherers: [instructionFilesGatherer()] });
        expect(results.instructions).toEqual({ files: ["AGENTS.md"], incomplete: true });
    });
});

describe("projects and test commands", () => {
    const workspace = {
        "package.json": '{ "name": "shop", "workspaces": ["packages/*"] }',
        "pnpm-lock.yaml": "",
        "packages/web/package.json": '{ "name": "web", "devDependencies": { "vitest": "^3" } }',
        "packages/web/src/cart.test.ts": TS_TEST,
        "packages/web/src/cart.ts": "export const cart = 1;\n",
        "tools/pyproject.toml": "[tool.pytest.ini_options]\n",
        "tools/test_totals.py": "import pytest\n\ndef test_totals():\n    assert True\n",
        "app/package.json": '{ "packageManager": "yarn@4.1.0", "scripts": { "test": "jest" } }',
        "app/package-lock.json": "{}",
        "app/src/a.test.ts": TS_TEST,
        "legacy/package.json": '{ "scripts": { "test": "mocha" } }',
        "legacy/b.test.js": TS_TEST,
    };

    test("a workspace package inherits the lockfile at the top; the declared manager outranks a lockfile", async () => {
        const { reader } = memoryReader(workspace);
        const { results } = await gatherRepoContext({
            reader,
            targets: [target("packages/web/src/cart.ts"), target("app/src/a.test.ts"), target("tools/test_totals.py")],
            gatherers: [projectsGatherer()],
        });
        expect(
            results.projects?.map(({ manifest, ecosystem, packageManager, testRunner, targets }) => ({
                manifest,
                ecosystem,
                packageManager,
                testRunner,
                targets,
            }))
        ).toEqual([
            {
                manifest: "packages/web/package.json",
                ecosystem: "node",
                packageManager: "pnpm",
                testRunner: "vitest",
                targets: ["packages/web/src/cart.ts"],
            },
            {
                manifest: "app/package.json",
                ecosystem: "node",
                packageManager: "yarn",
                testRunner: "package-script",
                targets: ["app/src/a.test.ts"],
            },
            {
                manifest: "tools/pyproject.toml",
                ecosystem: "python",
                packageManager: "pip",
                testRunner: "pytest",
                targets: ["tools/test_totals.py"],
            },
        ]);
    });

    test("a command per shown test case, run from the owning project, never for an unshown case", async () => {
        const { reader } = memoryReader(workspace);
        const shown = [{ startLine: 1, endLine: 5 }];
        const { results } = await gatherRepoContext({
            reader,
            targets: [
                target("packages/web/src/cart.test.ts", shown),
                target("app/src/a.test.ts", shown),
                target("legacy/b.test.js", [{ startLine: 1, endLine: 2 }]),
                target("tools/test_totals.py", shown),
                target("packages/web/src/cart.ts", shown),
            ],
            gatherers: [testCommandsGatherer()],
        });
        expect(results.testCommands?.map(({ cwd, argv }) => ({ cwd, argv }))).toEqual([
            { cwd: "packages/web", argv: ["pnpm", "exec", "vitest", "run", "src/cart.test.ts"] },
            { cwd: "app", argv: ["yarn", "run", "test", "src/a.test.ts"] },
            { cwd: "tools", argv: ["python", "-m", "pytest", "-q", "test_totals.py"] },
        ]);
    });

    test("npm forwards the file after --, and a pytest import wins in a project that never names pytest", async () => {
        const { reader } = memoryReader({
            "package.json": '{ "scripts": { "test": "node --test" } }',
            "a.test.ts": TS_TEST,
            "requirements.txt": "requests\n",
            "check_totals.py": "from pytest import raises\n\ndef test_raises():\n    pass\n",
        });
        const shown = [{ startLine: 1, endLine: 5 }];
        const { results } = await gatherRepoContext({
            reader,
            targets: [target("a.test.ts", shown), target("check_totals.py", shown)],
            gatherers: [testCommandsGatherer()],
        });
        expect(results.testCommands?.map(({ argv }) => argv)).toEqual([
            ["npm", "run", "test", "--", "a.test.ts"],
            ["python", "-m", "pytest", "-q", "check_totals.py"],
        ]);
    });
});

describe("gatherRepoContext", () => {
    test("a failing gatherer is named and the others still report; each file is read once", async () => {
        const { reader, reads } = memoryReader({
            "package.json": '{ "scripts": { "test": "bun test" } }',
            "bun.lock": "",
            "a.test.ts": TS_TEST,
        });
        const broken: ContextGatherer<"broken", never> = {
            id: "broken",
            gather: async () => {
                throw new Error("fixture failure");
            },
        };
        const outcome = await gatherRepoContext({
            reader,
            targets: [target("a.test.ts", [{ startLine: 1, endLine: 5 }], ["test"])],
            gatherers: [...defaultGatherers(), broken],
        });
        expect(outcome.failed).toEqual(["broken"]);
        expect(outcome.results.testCommands?.map(({ argv }) => argv)).toEqual([["bun", "run", "test", "a.test.ts"]]);
        expect(outcome.results.projects?.length).toBe(1);
        expect([...reads.values()].every((count) => count === 1)).toBe(true);
    });
});
