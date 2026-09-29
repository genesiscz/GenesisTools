import { posix } from "node:path";
import { relativeTo } from "./gather";
import { createProjectLocator, type ProjectInfo, type TestRunner } from "./projects";
import { coveredBy, isTestFilePath, locateTestCases } from "./test-cases";
import type { ContextGatherer, ContextTarget, RepoContextReader } from "./types";

/** A command a reader could run to exercise a returned test file. Never executed by the gatherer. */
export interface TestCommand {
    path: string;
    /** Directory to run it from, relative to the root; `.` for the root. */
    cwd: string;
    argv: string[];
    runner: TestRunner;
}

const PYTEST_IMPORT = /(^|\n)\s*(import pytest\b|from pytest\b)/;

function packageExec(manager: string): string[] {
    if (manager === "bun") {
        return ["bunx"];
    }

    if (manager === "pnpm") {
        return ["pnpm", "exec"];
    }

    return manager === "yarn" ? ["yarn"] : ["npx"];
}

/** The argv for one test file under its project's runner, with the file named relative to `cwd`. */
export function testCommandFor(project: ProjectInfo, path: string): TestCommand | undefined {
    const cwd = project.directory;
    const file = relativeTo(cwd, path);
    const command = (runner: TestRunner, argv: string[]): TestCommand => ({ path, cwd, argv, runner });
    switch (project.testRunner) {
        case "package-script":
            // npm alone needs `--` to forward an argument to the script.
            return command(
                "package-script",
                project.packageManager === "npm"
                    ? ["npm", "run", "test", "--", file]
                    : [project.packageManager, "run", "test", file]
            );
        case "vitest":
            return command("vitest", [...packageExec(project.packageManager), "vitest", "run", file]);
        case "jest":
            return command("jest", [...packageExec(project.packageManager), "jest", file]);
        case "mocha":
            return command("mocha", [...packageExec(project.packageManager), "mocha", file]);
        case "bun":
            return command("bun", ["bun", "test", file]);
        case "pytest":
            return command("pytest", ["python", "-m", "pytest", "-q", file]);
        case "cargo":
            return /(?:^|\/)tests\/[^/]+\.rs$/.test(file)
                ? command("cargo", ["cargo", "test", "--test", posix.basename(file, ".rs")])
                : undefined;
        case "go":
            return command("go", ["go", "test", `./${posix.dirname(file)}`]);
        case "phpunit":
            return command("phpunit", ["vendor/bin/phpunit", file]);
        case "pest":
            return command("pest", ["vendor/bin/pest", file]);
        case "rspec":
            return command("rspec", ["bundle", "exec", "rspec", file]);
        default:
            return undefined;
    }
}

/**
 * Does the caller show at least one test case of this target? Where a locator exists (TypeScript,
 * JavaScript, Python) a located case must sit inside a shown range. Elsewhere the test-file name and a
 * caller-assigned `test` role together stand in for it.
 */
async function showsTestCase(reader: RepoContextReader, target: ContextTarget): Promise<"pytest" | boolean> {
    if (!target.shownRanges.length) {
        return false;
    }

    const source = await reader.readText(target.path);
    if (source === undefined) {
        return false;
    }

    const cases = locateTestCases(target.path, source);
    if (!cases) {
        return isTestFilePath(target.path) && target.roles.includes("test");
    }

    if (!cases.some((range) => coveredBy(range, target.shownRanges))) {
        return false;
    }

    return /\.pyi?$/.test(target.path) && PYTEST_IMPORT.test(source) ? "pytest" : true;
}

function pytestProject(project: ProjectInfo | undefined): ProjectInfo {
    return {
        directory: project?.directory ?? ".",
        manifest: project?.manifest ?? "",
        ecosystem: "python",
        packageManager: project?.packageManager ?? "pip",
        testRunner: "pytest",
    };
}

/** One suggested, never-executed test command per returned test file that shows a test case. */
export function testCommandsGatherer(): ContextGatherer<"testCommands", TestCommand[]> {
    return {
        id: "testCommands",
        async gather({ reader, targets }) {
            const locator = createProjectLocator(reader);
            const commands: TestCommand[] = [];
            for (const target of targets) {
                const shown = await showsTestCase(reader, target);
                if (!shown) {
                    continue;
                }

                const project = await locator.projectFor(target.path);
                // A file that imports pytest is a pytest file even in a project that never names it.
                const runnable =
                    shown === "pytest" && project?.testRunner !== "pytest" ? pytestProject(project) : project;
                const command = runnable ? testCommandFor(runnable, target.path) : undefined;
                if (command) {
                    commands.push(command);
                }
            }

            return commands;
        },
    };
}
