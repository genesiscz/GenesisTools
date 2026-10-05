import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { setConsoleLevel } from "@genesiscz/utils/logger";
import { Command } from "commander";
import {
    addGlobalVerboseOption,
    applyVerbosityToEnv,
    argvRequestsReadme,
    getArgvVerbosity,
    isVerbose,
    reportUnhandledToolError,
    runTool,
} from "./commander";

const BOUNDARY_FIXTURE = join(import.meta.dir, "__fixtures__/run-tool-boundary.ts");

const ORIGINAL_LOG_DEBUG = env.get("LOG_DEBUG");
const ORIGINAL_LOG_TRACE = env.get("LOG_TRACE");

afterEach(() => {
    if (ORIGINAL_LOG_DEBUG === undefined) {
        env.testing.unset("LOG_DEBUG");
    } else {
        env.testing.set("LOG_DEBUG", ORIGINAL_LOG_DEBUG);
    }

    if (ORIGINAL_LOG_TRACE === undefined) {
        env.testing.unset("LOG_TRACE");
    } else {
        env.testing.set("LOG_TRACE", ORIGINAL_LOG_TRACE);
    }
});

describe("global Commander verbose option", () => {
    it("accepts verbose flags after nested subcommands", () => {
        const program = addGlobalVerboseOption(new Command());
        const mail = program.command("mail");
        let query = "";

        mail.command("search <query>").action((value: string) => {
            query = value;
        });

        program.exitOverride();
        program.parse(["node", "test", "mail", "search", "invoice", "--verbose"]);

        expect(query).toBe("invoice");
        expect(program.opts().verbose).toBe(1);
    });

    it("counts repeated short verbose flags", () => {
        expect(getArgvVerbosity(["-v"])).toBe(1);
        expect(getArgvVerbosity(["-vv"])).toBe(2);
        expect(getArgvVerbosity(["-vvv"])).toBe(3);
    });

    it("sets debug and trace environment variables from verbosity", () => {
        env.testing.unset("LOG_DEBUG");
        env.testing.unset("LOG_TRACE");

        applyVerbosityToEnv(2);

        expect(env.log.isDebug()).toBe(true);
        expect(env.log.isTrace()).toBe(true);
    });
});

describe("runTool", () => {
    it("registers -v + --readme on the program (visible in help), non-destructive argv", async () => {
        const prog = new Command();
        prog.name("demo").exitOverride();
        let ran = false;
        prog.action(() => {
            ran = true;
        });
        const argv = ["bun", "demo", "-v"];
        const res = await runTool(prog, { tool: "demo" }, argv);
        expect(ran).toBe(true);
        expect(res.tool).toBe("demo");
        expect(res.isVerbose).toBe(true);
        expect(isVerbose()).toBe(true);
        expect(argv.includes("-v")).toBe(true);
        const help = prog.helpInformation();
        expect(help).toContain("-v, --verbose");
        expect(help).toContain("--readme");
    });

    it("refuses to launch the CLI when the process entry is a test file", async () => {
        // Bun.main is this test file, so a runTool() with no argv means an
        // entrypoint ran the CLI because a test imported it. That is the shape
        // that stopped the whole suite from terminating on 2026-08-27.
        const prog = new Command();
        prog.name("hung").exitOverride();
        prog.action(() => {});

        expect(runTool(prog, { tool: "hung" })).rejects.toThrow(/imported by a test/);
    });

    it("still runs when a test passes its own argv (the negative control)", async () => {
        const prog = new Command();
        prog.name("explicit").exitOverride();
        let ran = false;
        prog.action(() => {
            ran = true;
        });

        const res = await runTool(prog, { tool: "explicit" }, ["bun", "explicit"]);
        expect(ran).toBe(true);
        expect(res.tool).toBe("explicit");
    });

    it("does not register --trace unless opts.trace; tool's own -v dedupes (no crash)", async () => {
        const prog = new Command();
        prog.name("d2").exitOverride().option("-v, --verbose", "tool's own");
        prog.action(() => {});
        const res = await runTool(prog, { tool: "d2" }, ["bun", "d2"]);
        expect(res.tool).toBe("d2");
        expect(prog.helpInformation()).not.toContain("--trace");
        expect(prog.helpInformation()).toContain("tool's own");
    });
});

describe("readme loading", () => {
    it("does not statically import @genesiscz/utils/readme (markdown + highlight.js)", () => {
        const src = readFileSync(join(import.meta.dir, "commander.ts"), "utf8");
        expect(src).not.toMatch(/from\s+["']@genesiscz\/utils\/readme["']/);
        expect(src).toMatch(/import\(["']@genesiscz\/utils\/readme["']\)/);
    });
});

describe("argvRequestsReadme", () => {
    it("detects --readme before subcommand parse", () => {
        expect(argvRequestsReadme(["--readme"])).toBe(true);
        expect(argvRequestsReadme(["run", "--session", "x", "--readme"])).toBe(true);
        expect(argvRequestsReadme(["run", "--session", "x"])).toBe(false);
    });

    it("ignores --readme after the `--` separator (child-process argv)", () => {
        // Was a real foot-gun: `tools task run --session foo -- bash --readme`
        // used to print the task README instead of running bash.
        expect(argvRequestsReadme(["run", "--session", "x", "--", "bash", "--readme"])).toBe(false);
        expect(argvRequestsReadme(["run", "--", "npx", "tool", "--readme=foo"])).toBe(false);
    });
});

describe("addGlobalVerboseOption trace gate", () => {
    // The {trace} gate was pulled forward into Task 13 (runTool needs it),
    // so this standalone Task-14 test is green on arrival by design — it
    // pins the gate behaviour independently of runTool.
    it("omits --trace by default, includes when {trace:true}", () => {
        const a = new Command();
        addGlobalVerboseOption(a);
        expect(a.helpInformation()).not.toContain("--trace");
        const b = new Command();
        addGlobalVerboseOption(b, { trace: true });
        expect(b.helpInformation()).toContain("--trace");
    });
});

// reportUnhandledToolError alone passes even when runTool stops calling it, so the boundary is tested through
// runTool: a real run (a child process, because runTool refuses process.argv under the test runner) and a caller
// that passes its own argv.
describe("runTool error boundary", () => {
    async function runFixture(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const proc = Bun.spawn(["bun", "run", BOUNDARY_FIXTURE, ...args], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        return { exitCode, stdout, stderr };
    }

    it("reports an action error from a real run as one ERROR line and exits 1", async () => {
        const run = await runFixture("boom");

        expect(run.exitCode).toBe(1);
        expect(run.stderr.match(/^ERROR: boom$/gm)?.length).toBe(1);
        expect(run.stderr).not.toContain("run-tool-boundary.ts");
        expect(run.stdout).toBe("");
    });

    it("leaves a Commander error to Commander's own exit path", async () => {
        const run = await runFixture("nope");

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("unknown command 'nope'");
        expect(run.stderr).not.toContain("ERROR:");
    });

    it("hands an action error back to a caller that passes its own argv", async () => {
        const program = new Command("explicit");
        program.command("boom").action(() => {
            throw new Error("boom");
        });

        await expect(runTool(program, { tool: "explicit" }, ["bun", "explicit", "boom"])).rejects.toThrow("boom");
    });
});

// Regression test: an error a tool's action did not catch (e.g. `tools artifact build missing.tsx`)
// reached Bun's top level, which printed a source code frame and a stack instead of one line
describe("reportUnhandledToolError", () => {
    const message = '"missing.tsx" is neither a registered dashboard name, a file, nor a directory.';

    // The logger's console sink writes through process.stderr, so this sees what a user sees
    function captureStderr(run: () => void): string {
        const chunks: string[] = [];
        const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            chunks.push(String(chunk));
            return true;
        });

        try {
            run();
        } finally {
            spy.mockRestore();
        }

        return chunks.join("");
    }

    it("prints one ERROR line and sets exit code 1", () => {
        const previous = process.exitCode;
        setConsoleLevel("info");

        try {
            const stderr = captureStderr(() => reportUnhandledToolError(new Error(message)));
            expect(stderr).toBe(`ERROR: ${message}\n`);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = previous;
        }
    });

    // Regression test: -v lowers the console gate to debug, so the debug record printed the stack and the
    // handler wrote the same stack a second time
    it("prints the stack once when the console level is debug", () => {
        const error = new Error(message);
        const frame = error.stack
            ?.split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("at "));
        if (!frame) {
            throw new Error("the test error has no stack frame");
        }

        const previous = process.exitCode;
        setConsoleLevel("debug");

        try {
            const stderr = captureStderr(() => reportUnhandledToolError(error));
            expect(stderr.split(frame).length - 1).toBe(1);
            expect(stderr).toContain(`ERROR: ${message}`);
        } finally {
            setConsoleLevel("info");
            process.exitCode = previous;
        }
    });
});
