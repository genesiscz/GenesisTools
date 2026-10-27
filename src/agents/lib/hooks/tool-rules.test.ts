import { describe, expect, it } from "bun:test";
import { detectShellViolations, SHELL_RULES, type ShellViolation } from "@genesiscz/utils/shell/rules";
import { BUILT_IN_RULES, GENESIS_TOOLS_RULES } from "./tool-rules";

function ids(command: string): string[] {
    return detectShellViolations(command, BUILT_IN_RULES).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, BUILT_IN_RULES).find((v) => v.ruleId === ruleId);
}

describe("GenesisTools guard rules", () => {
    it("have ids the shared registry does not use, and their own examples trip only them", () => {
        const shared = new Set(SHELL_RULES.map((rule) => rule.id));

        for (const rule of GENESIS_TOOLS_RULES) {
            expect(shared.has(rule.id)).toBe(false);
            expect(detectShellViolations(rule.wrong, [rule]).map((v) => v.ruleId)).toEqual([rule.id]);
            expect(detectShellViolations(rule.right, [rule])).toEqual([]);
            expect(rule.why.length).toBeGreaterThan(80);
        }
    });
});

describe("rm-user-verbs", () => {
    const caught = [
        "tools rm approve k7m2qd",
        "./tools rm approve k7m2qd",
        "cd /tmp && tools rm roots add /tmp/cc/x",
        "tools rm config set trash-root /tmp/GenesisTools/other",
        "script -q /dev/null tools rm approve k7m2qd",
        "bun src/rm/index.ts approve k7m2qd",
    ];

    it.each(caught)("blocks %j", (command) => {
        expect(ids(command)).toContain("rm-user-verbs");
    });

    const allowed = ["tools rm requests", "tools rm roots", "tools rm roots remove /tmp/x", "tools rm deny k7m2qd"];

    it.each(allowed)("leaves %j alone", (command) => {
        expect(ids(command)).not.toContain("rm-user-verbs");
    });
});

describe("rm-use-tools-rm", () => {
    it("blocks a bare rm and offers tools rm with the same paths", () => {
        const v = only("rm -rf node_modules dist", "rm-use-tools-rm");

        expect(v?.severity).toBe("block");
        expect(v?.suggestion).toBe("tools rm node_modules dist");
    });

    it("keeps the rest of a compound command in the suggestion", () => {
        expect(only("cd /tmp/x && rm -f out.log", "rm-use-tools-rm")?.suggestion).toBe("cd /tmp/x && tools rm out.log");
    });

    it.each(["/bin/rm -r build", "command rm -rf build", "find . -name '*.orig' | xargs rm", "sudo rm -rf /var/x"])(
        "blocks %j",
        (command) => {
            expect(ids(command)).toContain("rm-use-tools-rm");
        }
    );

    it.each(["git rm --cached x", "docker rm app", "tools rm build", "npm rm left-pad", "echo rm is banned"])(
        "leaves %j alone",
        (command) => {
            expect(ids(command)).not.toContain("rm-use-tools-rm");
        }
    );
});
