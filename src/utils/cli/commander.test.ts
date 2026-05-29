import { afterEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import {
    addGlobalVerboseOption,
    applyVerbosityToEnv,
    argvRequestsReadme,
    getArgvVerbosity,
    isVerbose,
    runTool,
} from "./commander";

const ORIGINAL_LOG_DEBUG = process.env.LOG_DEBUG;
const ORIGINAL_LOG_TRACE = process.env.LOG_TRACE;

afterEach(() => {
    if (ORIGINAL_LOG_DEBUG === undefined) {
        delete process.env.LOG_DEBUG;
    } else {
        process.env.LOG_DEBUG = ORIGINAL_LOG_DEBUG;
    }

    if (ORIGINAL_LOG_TRACE === undefined) {
        delete process.env.LOG_TRACE;
    } else {
        process.env.LOG_TRACE = ORIGINAL_LOG_TRACE;
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
        delete process.env.LOG_DEBUG;
        delete process.env.LOG_TRACE;

        applyVerbosityToEnv(2);

        expect(process.env.LOG_DEBUG === "1").toBe(true);
        expect(process.env.LOG_TRACE === "1").toBe(true);
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
