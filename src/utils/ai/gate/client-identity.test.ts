import { describe, expect, test } from "bun:test";
import type { PsRow } from "@genesiscz/utils/process/ps";
import {
    clientKey,
    codeInjectionSignals,
    describeClient,
    executableOf,
    isAncestorPid,
    isInterpreter,
    type ProcessLookup,
    scriptOf,
} from "./client-identity";

function row(pid: number, ppid: number, command: string): PsRow {
    return { pid, ppid, user: "martin", stat: "S", cpu: 0, rss: 0, startTime: null, command };
}

function lookupOf(
    rows: PsRow[],
    cwds: Record<number, string> = {},
    executables: Record<number, string> = Object.fromEntries(rows.map((r) => [r.pid, r.command.split(" ")[0]])),
    environments: Record<number, string> = {}
): ProcessLookup {
    return {
        psInfo: (pids) => new Map(rows.filter((r) => pids.includes(r.pid)).map((r) => [r.pid, r])),
        cwd: (pids) => new Map(pids.filter((pid) => cwds[pid]).map((pid) => [pid, cwds[pid]])),
        executable: (pids) => new Map(pids.filter((pid) => executables[pid]).map((pid) => [pid, executables[pid]])),
        environment: (pids) => new Map(pids.filter((pid) => environments[pid]).map((pid) => [pid, environments[pid]])),
    };
}

describe("describeClient", () => {
    test("reports executable, cwd and the parent chain nearest first", () => {
        const lookup = lookupOf(
            [
                row(1, 0, "/sbin/launchd"),
                row(500, 1, "cmux"),
                row(600, 500, "-zsh"),
                row(700, 600, "node /opt/pi/bin/pi --model x"),
                row(800, 700, "tools ai gate request"),
            ],
            { 700: "/Users/martin/proj" }
        );
        const identity = describeClient({ name: "pi", pid: 700 }, lookup, 800);

        expect(identity.verified).toBe(true);
        expect(identity.executable).toBe("node");
        expect(identity.cwd).toBe("/Users/martin/proj");
        expect(identity.ancestors.map((a) => a.command)).toEqual(["-zsh", "cmux"]);
        expect(identity.script).toBe("/opt/pi/bin/pi");
        expect(identity.key).toBe(clientKey("pi", "node", "/opt/pi/bin/pi"));
    });

    test("a pid that is not running yields nulls and a name-only key, never a throw", () => {
        const identity = describeClient({ name: "pi", pid: 4242 }, lookupOf([]));

        expect(identity.executable).toBeNull();
        expect(identity.cwd).toBeNull();
        expect(identity.ancestors).toEqual([]);
        expect(identity.key).toBe(clientKey("pi", null));
    });

    test("the key changes with the executable, so a renamed binary asks again", () => {
        expect(clientKey("pi", "/usr/bin/node")).not.toBe(clientKey("pi", "/tmp/evil/node"));
        expect(clientKey("pi", null)).not.toBe(clientKey("pi", "node"));
    });

    test("executableOf takes argv[0]", () => {
        expect(executableOf("  /opt/homebrew/bin/bun run x.ts  ")).toBe("/opt/homebrew/bin/bun");
    });

    test("verified only when the pid is an ancestor of the gate process", () => {
        const lookup = lookupOf([
            row(1, 0, "/sbin/launchd"),
            row(500, 1, "cmux"),
            row(600, 500, "-zsh"),
            row(700, 600, "node /opt/pi/bin/pi"),
            row(800, 700, "tools ai gate request --client pi --pid 700"),
            row(900, 800, "bun src/ai/index.ts gate request"),
            row(555, 600, "node /opt/other/bin/other"),
        ]);

        expect(isAncestorPid(700, lookup, 900)).toBe(true);
        expect(isAncestorPid(600, lookup, 900)).toBe(true);
        expect(isAncestorPid(555, lookup, 900)).toBe(false);
        expect(isAncestorPid(900, lookup, 900)).toBe(false);
        // launchd is everyone's ancestor, so it verifies nobody.
        expect(isAncestorPid(1, lookup, 900)).toBe(false);
        expect(isAncestorPid(0, lookup, 900)).toBe(false);
        expect(describeClient({ name: "pi", pid: 700 }, lookup, 900).verified).toBe(true);
        // A bystander naming Pi's pid from another branch of the tree: running, but not above the gate.
        expect(describeClient({ name: "pi", pid: 700 }, lookup, 555).verified).toBe(false);
        expect(describeClient({ name: "pi", pid: 4242 }, lookup, 900).verified).toBe(false);
        expect(describeClient({ name: "pi" }, lookup, 900).verified).toBe(false);
    });

    test("the key uses the kernel's executable path, so a spoofed argv[0] never matches a remembered grant", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "/opt/pi/bin/node /opt/pi/bin/pi"),
            row(701, 600, "/opt/pi/bin/node /opt/pi/bin/pi"),
            row(800, 700, "tools ai gate request"),
            row(801, 701, "tools ai gate request"),
        ];
        // 701 execs with argv[0] copied from Pi, but the kernel runs a different binary.
        const lookup = lookupOf(rows, {}, { 700: "/opt/pi/bin/node", 701: "/tmp/evil/node", 600: "/bin/zsh" });
        const pi = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        const impostor = describeClient({ name: "pi", pid: 701 }, lookup, 801);

        expect(pi.verified).toBe(true);
        expect(pi.executable).toBe("/opt/pi/bin/node");
        expect(impostor.verified).toBe(true);
        expect(impostor.executable).toBe("/tmp/evil/node");
        expect(impostor.key).not.toBe(pi.key);
    });

    test("without a kernel path the identity shows ps's command but is unverified with a name-only key", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "node pi"),
            row(800, 700, "tools"),
        ];
        const lookup = lookupOf(rows, {}, {});
        const identity = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        expect(identity.executable).toBe("node");
        expect(identity.isAncestor).toBe(true);
        expect(identity.verified).toBe(false);
        expect(identity.key).toBe(clientKey("pi", null));
    });

    test("an interpreter client is keyed on its script too, so another node program never shares the grant", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "node /opt/pi/bin/pi"),
            row(701, 600, "node ./evil.js"),
            row(702, 600, "node"),
            row(800, 700, "tools ai gate request"),
            row(801, 701, "tools ai gate request"),
            row(802, 702, "tools ai gate request"),
        ];
        const lookup = lookupOf(
            rows,
            { 701: "/tmp/other" },
            { 700: "/usr/local/bin/node", 701: "/usr/local/bin/node", 702: "/usr/local/bin/node" }
        );
        const pi = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        const other = describeClient({ name: "pi", pid: 701 }, lookup, 801);
        const bare = describeClient({ name: "pi", pid: 702 }, lookup, 802);

        expect(pi.verified).toBe(true);
        expect(pi.script).toBe("/opt/pi/bin/pi");
        expect(other.verified).toBe(true);
        expect(other.script).toBe("/tmp/other/evil.js");
        expect(other.key).not.toBe(pi.key);
        // A bare interpreter with no script: a real ancestor, but nothing to remember it by.
        expect(bare.isAncestor).toBe(true);
        expect(bare.verified).toBe(false);
        expect(bare.key).toBe(clientKey("pi", null));
    });

    test("interpreter flags or code-loading environment before Pi's script block remembering", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "node /opt/pi/cli.js"),
            row(701, 600, "node --require=/tmp/evil.js /opt/pi/cli.js"),
            row(702, 600, "node -r /tmp/evil.js /opt/pi/cli.js"),
            row(703, 600, "node /opt/pi/cli.js"),
            row(800, 700, "tools"),
            row(801, 701, "tools"),
            row(802, 702, "tools"),
            row(803, 703, "tools"),
        ];
        const executables = { 700: "/usr/bin/node", 701: "/usr/bin/node", 702: "/usr/bin/node", 703: "/usr/bin/node" };
        const environments = { 703: "node /opt/pi/cli.js HOME=/Users/x NODE_OPTIONS=--require=/tmp/evil.js PATH=/bin" };
        const lookup = lookupOf(rows, {}, executables, environments);

        const pi = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        expect(pi.verified).toBe(true);
        expect(pi.injected).toEqual([]);

        const flagged = describeClient({ name: "pi", pid: 701 }, lookup, 801);
        expect(flagged.script).toBe("/opt/pi/cli.js");
        expect(flagged.isAncestor).toBe(true);
        expect(flagged.injected).toEqual(["flag --require"]);
        expect(flagged.verified).toBe(false);
        expect(flagged.key).not.toBe(pi.key);

        expect(describeClient({ name: "pi", pid: 702 }, lookup, 802).injected).toEqual(["flag -r"]);
        const env = describeClient({ name: "pi", pid: 703 }, lookup, 803);
        expect(env.injected).toEqual(["env NODE_OPTIONS"]);
        expect(env.verified).toBe(false);
        expect(codeInjectionSignals("node cli.js", "node cli.js ENV=/etc/x LANG=C")).toEqual(["env ENV"]);
        expect(codeInjectionSignals("node cli.js", "node cli.js ENVIRONMENT=prod")).toEqual([]);
    });

    test("scriptOf skips flags and needs a cwd for a relative path; a plain binary has no script", () => {
        expect(scriptOf("node --max-old-space-size=4096 /opt/pi/cli.js --model x", null)).toBe("/opt/pi/cli.js");
        expect(scriptOf("python3 -u tool.py", "/work")).toBe("/work/tool.py");
        expect(scriptOf("python3 -u tool.py", null)).toBeNull();
        expect(scriptOf("bun", "/work")).toBeNull();
        expect(isInterpreter("/usr/bin/python3.12")).toBe(true);
        expect(isInterpreter("/Applications/Pi.app/Contents/MacOS/pi")).toBe(false);
    });
});
