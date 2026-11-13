import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFailures, type ToolFailure } from "@genesiscz/utils/cli/failures/record";
import { env } from "@genesiscz/utils/env";
import { setConsoleLevel } from "@genesiscz/utils/logger";
import { isPromptCancel, PromptCancelledError } from "@genesiscz/utils/prompts/cancel";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { Command } from "commander";
import {
    addGlobalVerboseOption,
    applyVerbosityToEnv,
    getArgvVerbosity,
    isVerbose,
    reportUnhandledToolError,
    runTool,
} from "./commander";
import { acceptJsonEverywhere, suggestOnlySafeCommands } from "./commander-hints";
import type { LazyRegistrar } from "./lazy-registrars";
import { answerReadmeFlag, argvRequestsReadme } from "./readme-flag";

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

describe("runTool registrars", () => {
    function table(loaded: string[]): LazyRegistrar[] {
        return ["alpha", "beta"].map((name) => ({
            names: name === "beta" ? ["beta", "b2"] : [name],
            load: async () => {
                loaded.push(name);

                return (program: Command) => {
                    program
                        .command(name)
                        .alias(name === "beta" ? "b2" : `${name}-alias`)
                        .requiredOption("--need <value>", "a required flag")
                        .action(() => {});
                };
            },
        }));
    }

    it("registers only the tree argv names, and gives it the help passes of an eager tree", async () => {
        const loaded: string[] = [];
        const prog = new Command().name("lazy").exitOverride();

        await runTool(prog, { tool: "lazy", registrars: table(loaded) }, ["bun", "lazy", "beta", "--need", "x"]);

        expect(loaded).toEqual(["beta"]);
        const beta = prog.commands.find((command) => command.name() === "beta");
        expect(beta?.helpInformation()).toContain("(required)");
    });

    it("reads the argv after rewriteArgs", async () => {
        const loaded: string[] = [];
        const prog = new Command().name("lazy").exitOverride();

        await runTool(
            prog,
            {
                tool: "lazy",
                registrars: table(loaded),
                rewriteArgs: (args) => (args[0] === "a" ? ["alpha", ...args.slice(1)] : args),
            },
            ["bun", "lazy", "a", "--need", "x"]
        );

        expect(loaded).toEqual(["alpha"]);
    });

    it("registers every tree for an unknown name, so commander can suggest one", async () => {
        const loaded: string[] = [];
        const prog = new Command().name("lazy").exitOverride();

        await expect(
            runTool(prog, { tool: "lazy", registrars: table(loaded) }, ["bun", "lazy", "nope"])
        ).rejects.toThrow();
        expect(loaded).toEqual(["alpha", "beta"]);
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

    it("answerReadmeFlag returns without loading the README when argv does not ask for it", async () => {
        // A README request would print and exit this test process; reaching the expect proves it did not.
        await answerReadmeFlag(import.meta.dir, ["run", "--", "bash", "--readme"]);
        expect(true).toBe(true);
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
    // Each run gets its own home, so the failure record it writes can be read back.
    async function runFixture(
        ...args: string[]
    ): Promise<{ exitCode: number; stdout: string; stderr: string; failures: ToolFailure[] }> {
        const home = mkdtempSync(join(tmpdir(), "gt-run-tool-"));
        const proc = Bun.spawn(["bun", "run", BOUNDARY_FIXTURE, ...args], {
            env: { ...process.env, GENESIS_TOOLS_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        const failures = [
            ...readFailures({ fromDay: "0000-00-00", toDay: "9999-99-99", dir: genesisToolsDirIn(home, "logs") }),
        ];
        return { exitCode, stdout, stderr, failures };
    }

    it("reports an action error from a real run as one ERROR line and exits 1", async () => {
        const run = await runFixture("boom");

        expect(run.exitCode).toBe(1);
        expect(run.stderr.match(/^ERROR: boom$/gm)?.length).toBe(1);
        expect(run.stderr).not.toContain("run-tool-boundary.ts");
        expect(run.stdout).toBe("");
        expect(run.failures.map((failure) => [failure.kind, failure.tool, failure.command, failure.message])).toEqual([
            ["error", "boundary", "boundary boom", "boom"],
        ]);
        expect(run.failures[0].stack).toContain("Error: boom");
    });

    it("treats a cancelled prompt as exit 0 with no ERROR line and no failure record", async () => {
        for (const command of ["cancel", "legacy-cancel"]) {
            const run = await runFixture(command);

            expect(run.exitCode).toBe(0);
            expect(run.stderr).not.toContain("ERROR:");
            expect(run.stdout).toBe("");
            expect(run.failures.filter((failure) => failure.kind === "error")).toEqual([]);
        }
    });

    it("prints a tool's formatError report with its exit code and still records the failure", async () => {
        const run = await runFixture("formatted");

        expect(run.exitCode).toBe(3);
        expect(run.stderr.match(/^custom report$/gm)?.length).toBe(1);
        expect(run.stderr).not.toContain("ERROR:");
        expect(run.failures.map((failure) => [failure.kind, failure.message])).toEqual([["error", "formatted"]]);
    });

    it("falls back to the default report when formatError throws", async () => {
        const run = await runFixture("formatter-throws");

        expect(run.exitCode).toBe(1);
        expect(run.stderr.match(/^ERROR: formatter-throws$/gm)?.length).toBe(1);
        expect(run.stderr).not.toContain("the formatter broke");
    });

    it("leaves a Commander error to Commander's own exit path", async () => {
        const run = await runFixture("nope");

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("unknown command 'nope'");
        expect(run.stderr).not.toContain("ERROR:");
        expect(run.failures.map((failure) => [failure.kind, failure.argv, failure.message, failure.exitCode])).toEqual([
            ["usage", ["nope"], "error: unknown command 'nope'", 1],
        ]);
    });

    it("hands an action error back to a caller that passes its own argv", async () => {
        const program = new Command("explicit");
        program.command("boom").action(() => {
            throw new Error("boom");
        });

        await expect(runTool(program, { tool: "explicit" }, ["bun", "explicit", "boom"])).rejects.toThrow("boom");
    });
});

describe("isPromptCancel", () => {
    it("knows every form of a user cancel", () => {
        const inquirer = new Error("User force closed the prompt with SIGINT");
        inquirer.name = "ExitPromptError";

        expect(isPromptCancel(new PromptCancelledError())).toBe(true);
        expect(isPromptCancel(inquirer)).toBe(true);
        expect(isPromptCancel(new Error("Cancelled"))).toBe(true);
    });

    it("leaves every other error to the error report", () => {
        expect(isPromptCancel(new Error("boom"))).toBe(false);
        expect(isPromptCancel(new Error("Cancelled by the server"))).toBe(false);
        expect(isPromptCancel("Cancelled")).toBe(false);
        expect(isPromptCancel(undefined)).toBe(false);
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

describe("subcommand hints that never point at a write", () => {
    const program = (): { program: Command; errors: string[] } => {
        const errors: string[] = [];
        const built = new Command()
            .exitOverride()
            .configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => {} });
        for (const name of ["start", "stop", "status", "list", "undo", "project"]) {
            built.command(name).action(() => {});
        }

        built
            .command("search")
            .option("--json", "its own")
            .action(() => {});
        return { program: built, errors };
    };

    it("an unknown command is hinted only with a command that changes nothing, or not at all", () => {
        for (const [typed, hint] of [
            ["show", undefined],
            ["info", undefined],
            ["stat", "status"],
            ["lst", "list"],
        ] as const) {
            const { program: built, errors } = program();
            suggestOnlySafeCommands(built, ["status", "list", "search", "project"]);
            expect(() => built.parse(["node", "tool", typed])).toThrow(`unknown command '${typed}'`);
            const said = errors.join("");
            expect(said).not.toMatch(/Did you mean (stop|start|undo)/);
            expect(said.includes(`Did you mean ${hint}?`)).toBe(hint !== undefined);
        }
    });

    it("--json is accepted by every subcommand, and a command's own --json keeps its description", () => {
        const { program: built } = program();
        acceptJsonEverywhere(built, "accepted for scripts");
        expect(() => built.parse(["node", "tool", "undo", "--json"])).not.toThrow();
        const search = built.commands.find((command) => command.name() === "search");
        expect(
            search?.options.filter((option) => option.long === "--json").map((option) => option.description)
        ).toEqual(["its own"]);
    });
});
