import { describe, expect, it } from "bun:test";

import { detectShellViolations, type ShellViolation } from "./index";
import { zshRules } from "./zsh";

function ids(command: string): string[] {
    return detectShellViolations(command, zshRules).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, zshRules).find((v) => v.ruleId === ruleId);
}

const GLOB = "zsh-glob-qualifier";
const LOG = "bare-log-command";

describe("zsh-glob-qualifier", () => {
    it("(N) fires with the qualifier as matched, no suggestion", () => {
        const command = "ls -d /tmp/*.log(N)";
        const v = only(command, GLOB);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("(N)");
        expect(v?.index).toBe(command.indexOf("(N)"));
        expect(v?.suggestion).toBeUndefined();
    });

    it("(#qN) and longer qualifier strings fire", () => {
        expect(ids("ls *.log(#qN)")).toEqual([GLOB]);
        expect(ids("print -l ~/x/*(#qN.)")).toEqual([GLOB]);
        expect(ids("for f in *.har(N); do echo $f; done")).toEqual([GLOB]);
    });

    it("the recommended forms pass", () => {
        expect(ids("[ -e app.log ] && ls *.log")).toEqual([]);
        expect(ids("( setopt NULL_GLOB; ls -d /tmp/a* /tmp/b* )")).toEqual([]);
    });

    it("parens that are not a qualifier pass", () => {
        expect(ids("echo $(N)")).toEqual([]);
        expect(ids("f() { ls; }; (N)")).toEqual([]);
        expect(ids("echo '(N)'")).toEqual([]);
        expect(ids('echo "*.log(N)"')).toEqual([]);
        expect(ids("rg 'x(N)' src")).toEqual([]);
    });
});

describe("bare-log-command", () => {
    it("log show fires with `command` prepended in the suggestion", () => {
        const command = "log show --last 5m --predicate 'process == \"sharingd\"'";
        const v = only(command, LOG);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe(command);
        expect(v?.index).toBe(0);
        expect(v?.suggestion).toBe(`command ${command}`);
    });

    it("log stream / collect / config fire, log alone does not", () => {
        expect(ids("log stream --predicate 'x'")).toEqual([LOG]);
        expect(ids("log collect --last 1h")).toEqual([LOG]);
        expect(ids("log config --status")).toEqual([LOG]);
        expect(ids("log")).toEqual([]);
        expect(ids("log 2>&1")).toEqual([]);
    });

    it("later in a chain, with the offset pointing at log", () => {
        const command = "cd /tmp && log show --last 2m | head";
        const v = only(command, LOG);

        expect(v?.index).toBe(command.indexOf("log show"));
        expect(v?.matched).toBe("log show --last 2m");
        expect(v?.suggestion).toBe("cd /tmp && command log show --last 2m | head");
    });

    it("builtin log show still hits the builtin", () => {
        expect(ids("builtin log show --last 5m")).toEqual([LOG]);
    });

    it("a loop body or an if branch still hits the builtin", () => {
        expect(ids("for f in a b; do log show --last 5m; done")).toEqual([LOG]);
        expect(ids("if true; then log show --last 5m; fi")).toEqual([LOG]);
        expect(ids("for f in a; do command log show --last 5m; done")).toEqual([]);
    });

    it("command log, a path, or any exec wrapper reaches /usr/bin/log", () => {
        expect(ids("command log show --last 5m")).toEqual([]);
        expect(ids("/usr/bin/log show --last 5m")).toEqual([]);
        expect(ids("sudo log show --last 5m")).toEqual([]);
        expect(ids("env log show --last 5m")).toEqual([]);
        expect(ids("exec log stream")).toEqual([]);
        expect(ids("timeout 30 log show --last 5m")).toEqual([]);
    });

    it("other tools with a log subcommand pass", () => {
        expect(ids("git log --oneline -5")).toEqual([]);
        expect(ids("tools task logs --session x")).toEqual([]);
        expect(ids("xcrun simctl spawn UDID log show --last 90m")).toEqual([]);
        expect(ids("docker logs x")).toEqual([]);
        expect(ids("logger 'hi'")).toEqual([]);
    });

    it("prose", () => {
        expect(ids("echo 'log show'")).toEqual([]);
        expect(ids("# log show --last 1m\nls")).toEqual([]);
        expect(ids("cat <<'EOF'\nlog show\nEOF")).toEqual([]);
    });
});

describe("zsh rules: corpus fixtures", () => {
    const cases: Array<[string, string[]]> = [
        ["command log show --last 5m --predicate 'subsystem == \"com.apple.TCC\"' --style compact | head -20", []],
        ["log show --last 10m --predicate 'process == \"usernoted\"' --style compact 2>&1 | head", [LOG]],
        ["log stream --predicate 'subsystem == \"com.apple.usernotifications\"' --level debug", [LOG]],
        ["ls -la ~/Library/Logs/DiagnosticReports/*.ips(N) 2>&1", [GLOB]],
        ["ls ~/.genesis-tools/logs/*.log | tail -3", []],
    ];

    for (const [command, expected] of cases) {
        it(`${expected.join("+") || "silent"}: ${command.slice(0, 70)}`, () => {
            expect(ids(command)).toEqual(expected);
        });
    }
});
