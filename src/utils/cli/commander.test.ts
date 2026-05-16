import { afterEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { addGlobalVerboseOption, applyVerbosityToEnv, getArgvVerbosity } from "./commander";

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
