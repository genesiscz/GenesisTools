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
        // Root flags and `--` before the verb: Commander still runs the verb.
        "tools rm -v approve k7m2qd",
        "tools rm -- approve k7m2qd",
        "tools rm --json approve k7m2qd",
        "tools rm --keep 1d approve k7m2qd",
        "tools rm --keep=1d approve k7m2qd",
        'tools rm --reason "two words" approve k7m2qd',
        "tools rm -v -n roots add /tmp/x",
        "bun src/rm/index.ts -v approve k7m2qd",
        // A forced drain ends the grace period of every batch, approved ones and other sessions' too.
        "tools rm drain --now",
        "tools rm -v drain --now",
        "tools rm drain --background --now",
        "bun src/rm/index.ts drain --now",
        "tools rm approve --session aaaaaaaa",
        "tools rm approve k7m2qd --help",
    ];

    it.each(caught)("blocks %j", (command) => {
        expect(ids(command)).toContain("rm-user-verbs");
    });

    const allowed = [
        "tools rm requests",
        "tools rm roots",
        "tools rm roots remove /tmp/x",
        "tools rm deny k7m2qd",
        "tools rm ./approve",
        "tools rm -v requests --json",
        "tools rm -n node_modules",
        'git commit -m "document tools rm -v approve <id> for the user"',
        "tools rm drain",
        "tools rm trash",
        "tools rm --now dist",
        "tools rm drain && echo --nowhere",
        // The agent's verb: it only opens the person's window.
        "tools rm ask k7m2qd",
        "./tools rm ask k7m2qd &",
        // Help and a bare verb do nothing: Commander prints the help, or the verb asks for an id.
        "tools rm approve --help",
        "tools rm approve -h",
        "tools rm approve",
        "tools rm config set --help",
    ];

    it.each(allowed)("leaves %j alone", (command) => {
        expect(ids(command)).not.toContain("rm-user-verbs");
    });
});

describe("rm-user-verbs offers the agent's verb", () => {
    it("suggests tools rm ask for one request, and nothing for several or a filter", () => {
        expect(only("tools rm approve k7m2qd", "rm-user-verbs")?.suggestion).toBe("tools rm ask k7m2qd");
        expect(only("cd /w && tools rm approve k7m2qd", "rm-user-verbs")?.suggestion).toBe(
            "cd /w && tools rm ask k7m2qd"
        );
        expect(only("tools rm approve a1b2 c3d4", "rm-user-verbs")?.suggestion).toBeUndefined();
        expect(only("tools rm approve --older 1d", "rm-user-verbs")?.suggestion).toBeUndefined();
        expect(only("tools rm roots add /tmp/x", "rm-user-verbs")?.suggestion).toBeUndefined();
    });

    it("says approve is the person's verb and ask the agent's", () => {
        const rule = only("tools rm approve k7m2qd", "rm-user-verbs");

        expect(rule?.why).toContain("ask");
        expect(rule?.why).not.toContain("would approve itself");
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

    it("replaces only the matched command and preserves dollar sequences", () => {
        expect(only("echo rm -f x; rm -f x", "rm-use-tools-rm")?.suggestion).toBe("echo rm -f x; tools rm x");
        expect(only("rm -f /tmp/x.$$", "rm-use-tools-rm")?.suggestion).toBe("tools rm /tmp/x.$$");
    });

    it.each(["/bin/rm -r build", "command rm -rf build", "find . -name '*.orig' | xargs rm", "sudo rm -rf /var/x"])(
        "blocks %j",
        (command) => {
            expect(ids(command)).toContain("rm-use-tools-rm");
        }
    );

    it.each([
        "xargs -0 rm -f",
        "xargs -n 1 rm",
        "xargs -I {} rm {}",
        "xargs -- rm -rf",
        "xargs -l rm",
        "printf '%s\\n' victim | xargs -J '%' rm %",
        "xargs -I '{}' rm '{}'",
        "printf '%s\\n' victim | xargs --max-args 1 rm -f",
        "xargs --max-args=1 rm -f",
        "xargs --max-procs 4 --delimiter , rm",
        "xargs --arg-file list.txt rm",
        "xargs --max-a 1 rm",
        "xargs --null --no-run-if-empty rm",
    ])("blocks %j", (command) => {
        expect(ids(command)).toContain("rm-use-tools-rm");
    });

    it.each([
        "git ls-files -d | xargs git rm --cached",
        "git ls-files | xargs grep -l rm",
        "xargs echo rm",
        "xargs -I rm echo rm",
    ])("leaves %j alone: xargs runs no rm", (command) => {
        expect(ids(command)).not.toContain("rm-use-tools-rm");
    });

    it.each(["git rm --cached x", "docker rm app", "tools rm build", "npm rm left-pad", "echo rm is banned"])(
        "leaves %j alone",
        (command) => {
            expect(ids(command)).not.toContain("rm-use-tools-rm");
        }
    );
});

describe("rm-user-verbs and quoted text", () => {
    it("blocks profile set and remove", () => {
        expect(ids("tools rm profile set ci --agent codex")).toContain("rm-user-verbs");
        expect(ids("tools rm profile remove ci")).toContain("rm-user-verbs");
    });

    it("does not block a command that only mentions a verb inside a quoted string", () => {
        expect(ids(`git commit -m "document tools rm approve <id> for the user"`)).not.toContain("rm-user-verbs");
        expect(ids(`bun -e 'console.log("tools rm approve x")'`)).not.toContain("rm-user-verbs");
    });

    it("still blocks the verb inside a body the shell runs", () => {
        expect(ids(`bash -c "tools rm approve k7m2qd"`)).toContain("rm-user-verbs");
    });
});

describe("tmp-loose-scratch", () => {
    const session = "aaaaaaaa-1111-4111-8111-111111111111";
    const caught = [
        "echo hi > /tmp/out.txt",
        "bun run build 2>/tmp/build.log",
        'curl -sS https://example.com/a.json -o "/tmp/a.json"',
        "curl -sS https://example.com/a.json --output=/private/tmp/a.json",
        "bun test | tee $TMPDIR/test.log",
        "mkdir -p /tmp/probe",
        "mkdir -p /tmp/cc/shop/aaaaaaaa/run1",
        "echo x > /tmp/cc/shop/notes.txt",
    ];

    it.each(caught)("warns on %j", (command) => {
        const v = only(command, "tmp-loose-scratch");

        expect(v?.severity).toBe("warn");
        expect(command.slice(v?.index ?? 0)).toStartWith(v?.matched ?? "missing");
    });

    const allowed = [
        `echo hi > /tmp/cc/shop/${session}/out.txt`,
        `mkdir -p /tmp/cc/shop/${session}/worktrees/x`,
        "bun run build > /dev/null 2>&1",
        "echo hi > ./out.txt",
        "mkdir -p /tmp/cc",
        "mkdir -p /tmp/cc/shop",
        'git commit -m "echo hi > /tmp/out.txt"',
        "cat /tmp/out.txt",
    ];

    it.each(allowed)("leaves %j alone", (command) => {
        expect(ids(command)).not.toContain("tmp-loose-scratch");
    });
});

describe("rm-mv-into-scratch", () => {
    const scratch = "/tmp/cc/shop/aaaaaaaa-1111-4111-8111-111111111111";

    it.each([
        `mv ~/Downloads/old-build ${scratch}/ && tools rm ${scratch}/old-build`,
        `mv /work/shop/dist ${scratch}/dist; ./tools rm ${scratch}/dist`,
    ])("warns on %j", (command) => {
        expect(only(command, "rm-mv-into-scratch")?.severity).toBe("warn");
    });

    it.each([
        `mv ${scratch}/a ${scratch}/b && tools rm ${scratch}/b`,
        `mv ~/Downloads/old-build ${scratch}/`,
        "tools rm ~/Downloads/old-build",
        "mv ./a ./b && tools rm ./b",
    ])("leaves %j alone", (command) => {
        expect(ids(command)).not.toContain("rm-mv-into-scratch");
    });

    it("both scratch rules exist, and their examples trip no other built-in rule", () => {
        const scratchRules = GENESIS_TOOLS_RULES.filter((r) =>
            ["tmp-loose-scratch", "rm-mv-into-scratch"].includes(r.id)
        );

        expect(scratchRules.map((rule) => rule.id).sort()).toEqual(["rm-mv-into-scratch", "tmp-loose-scratch"]);

        for (const rule of scratchRules) {
            expect(ids(rule.wrong)).toEqual([rule.id]);
            expect(ids(rule.right)).toEqual([]);
        }
    });
});
