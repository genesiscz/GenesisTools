import { describe, expect, test } from "bun:test";
import { parseExecArgs } from "./exec";

describe("parseExecArgs", () => {
    test("no account flag leaves the whole argv as the command", () => {
        expect(parseExecArgs(["git", "status"])).toEqual({ name: undefined, command: ["git", "status"] });
    });

    test("-a takes the next word", () => {
        expect(parseExecArgs(["-a", "work", "git", "status"])).toEqual({ name: "work", command: ["git", "status"] });
    });

    test("--account takes the next word", () => {
        expect(parseExecArgs(["--account", "work", "git"])).toEqual({ name: "work", command: ["git"] });
    });

    test("--account=name form", () => {
        expect(parseExecArgs(["--account=work", "git"])).toEqual({ name: "work", command: ["git"] });
    });

    test("a child's own -a is NOT ours once the command started", () => {
        expect(parseExecArgs(["git", "-a", "commit"])).toEqual({ name: undefined, command: ["git", "-a", "commit"] });
    });

    test("a leading -- is stripped", () => {
        expect(parseExecArgs(["--", "--weird-binary"])).toEqual({ name: undefined, command: ["--weird-binary"] });
    });

    test("-a followed by -- strips the separator too", () => {
        expect(parseExecArgs(["-a", "work", "--", "env"])).toEqual({ name: "work", command: ["env"] });
    });

    test("empty argv yields an empty command so the caller can error", () => {
        expect(parseExecArgs([])).toEqual({ name: undefined, command: [] });
    });
});
