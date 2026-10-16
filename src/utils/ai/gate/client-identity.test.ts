import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PsRow } from "@genesiscz/utils/process/ps";
import {
    clientKey,
    codeInjectionSignals,
    describeClient,
    executableOf,
    fileStamps,
    isAncestorPid,
    isInterpreter,
    OWN_PRELOADS,
    type ProcessLookup,
    scriptOf,
} from "./client-identity";

const REPO = join(import.meta.dirname, "../../../..");

// Every tool the app started carried the launcher's orphan-watchdog preload, which neither list named, so the vault
// window said "Extra code may be loaded" and could never remember an approval (2026-10-16).
describe("the checkout's own preloads", () => {
    test("name every preload the launcher passes, and the Swift vault window keeps the same list", () => {
        const launcher = `${readFileSync(join(REPO, "tools"), "utf8")}\n${readFileSync(join(REPO, "src/utils/cli/tool-exec.ts"), "utf8")}`;
        const passed = [...launcher.matchAll(/"(src\/[^"]*preload[^"]*\.ts)"/g)].map((match) => match[1]);
        const swift = readFileSync(join(REPO, "src/macos/GenesisTools/Sources/VaultUnlock.swift"), "utf8");
        const swiftList = swift.match(/static let ownPreloads = \[([^\]]*)\]/)?.[1] ?? "";

        expect(passed.length).toBeGreaterThan(0);
        expect(OWN_PRELOADS).toEqual(expect.arrayContaining(passed));
        expect([...swiftList.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort()).toEqual([...OWN_PRELOADS].sort());
    });

    test("a gt-<tool> link of bun reads --preload <file> like bun does", () => {
        const root = "/work/GenesisTools";
        const preloads = OWN_PRELOADS.map((relative) => `--preload ${root}/${relative}`).join(" ");
        const gt = "/Users/x/.genesis-tools/bin/gt-mcp-manager";
        expect(
            codeInjectionSignals(`${gt} ${preloads} ${root}/src/mcp-manager/index.ts gateway start`, null, gt)
        ).toEqual([]);
        expect(isInterpreter(gt)).toBe(true);
        expect(scriptOf(`${gt} ${preloads} ${root}/src/mcp-manager/index.ts gateway start`, "/", gt)).toBe(
            `${root}/src/mcp-manager/index.ts`
        );
    });

    test("a tool the launcher starts with all its preloads shows no loaded-code signal", () => {
        const root = "/work/GenesisTools";
        const preloads = OWN_PRELOADS.map((relative) => `--preload ${root}/${relative}`).join(" ");
        expect(
            codeInjectionSignals(
                `/usr/bin/bun ${preloads} ${root}/src/mcp-manager/index.ts gateway start`,
                null,
                "/usr/bin/bun"
            )
        ).toEqual([]);
        expect(
            codeInjectionSignals(
                `/usr/bin/bun --preload /tmp/other.ts ${root}/src/mcp-manager/index.ts`,
                null,
                "/usr/bin/bun"
            )
        ).toEqual(["flag --preload"]);
    });
});

function row(pid: number, ppid: number, command: string): PsRow {
    return { pid, ppid, user: "martin", stat: "S", cpu: 0, rss: 0, startTime: null, command };
}

function lookupOf(
    rows: PsRow[],
    cwds: Record<number, string> = {},
    executables: Record<number, string> = Object.fromEntries(rows.map((r) => [r.pid, r.command.split(" ")[0]])),
    // `ps eww` prints at least the command line for a running process it can read; a pid missing
    // here is one whose environment could not be read.
    environments: Record<number, string> = Object.fromEntries(rows.map((r) => [r.pid, r.command])),
    // Every file stamps as `stamp:<path>` unless a test overrides it; `null` means "cannot stat".
    stampOf: (path: string) => string | null = (path) => `stamp:${path}`
): ProcessLookup {
    return {
        psInfo: (pids) => new Map(rows.filter((r) => pids.includes(r.pid)).map((r) => [r.pid, r])),
        cwd: (pids) => new Map(pids.filter((pid) => cwds[pid]).map((pid) => [pid, cwds[pid]])),
        executable: (pids) => new Map(pids.filter((pid) => executables[pid]).map((pid) => [pid, executables[pid]])),
        environment: (pids) => new Map(pids.filter((pid) => environments[pid]).map((pid) => [pid, environments[pid]])),
        fileStamps: (paths) =>
            new Map(
                paths.flatMap((path) => {
                    const stamp = stampOf(path);
                    return stamp === null ? [] : [[path, stamp] as const];
                })
            ),
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
        expect(identity.key).toBe(clientKey("pi", "node", "/opt/pi/bin/pi", "stamp:node\0stamp:/opt/pi/bin/pi"));
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
        const environments = {
            700: "node /opt/pi/cli.js HOME=/Users/x PATH=/bin",
            701: "node --require=/tmp/evil.js /opt/pi/cli.js HOME=/Users/x",
            702: "node -r /tmp/evil.js /opt/pi/cli.js HOME=/Users/x",
            703: "node /opt/pi/cli.js HOME=/Users/x NODE_OPTIONS=--require=/tmp/evil.js PATH=/bin",
        };
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

    test("GenesisTools' own preloads neither hide the script nor count as extra code", () => {
        // `tools claude login-long admin` as the tools wrapper starts it (2026-10-15: every login could be allowed
        // only once, and the preload was taken for the script).
        const bun = "/opt/bun/bin/bun";
        const login =
            "gt-claude --preload /repo/src/utils/bun/preload-solid-scoped.ts" +
            " --preload /repo/src/utils/search/stores/sqlite-vec-preload.ts /repo/src/claude/index.ts login-long admin";
        expect(scriptOf(login, null, bun)).toBe("/repo/src/claude/index.ts");
        expect(codeInjectionSignals(login, null, bun)).toEqual([]);

        const foreign = "gt-claude --preload /other/src/utils/bun/preload-solid-scoped.ts /repo/src/claude/index.ts";
        expect(scriptOf(foreign, null, bun)).toBe("/repo/src/claude/index.ts");
        expect(codeInjectionSignals(foreign, null, bun)).toEqual(["flag --preload"]);
        expect(codeInjectionSignals("bun --preload=/repo/src/utils/bun/x.ts /repo/src/a/index.ts", null, bun)).toEqual([
            "flag --preload",
        ]);
    });

    test("framework Python and other interpreters are matched without regard to case", () => {
        for (const path of [
            "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python",
            "/bin/dash",
            "/bin/ksh",
            "/usr/bin/osascript",
            "/usr/local/bin/lua5.4",
            "/usr/local/bin/pwsh",
            "/usr/bin/java",
        ]) {
            expect(isInterpreter(path)).toBe(true);
        }

        expect(isInterpreter("/usr/local/bin/pi")).toBe(false);
    });

    test("bun and deno skip `run`, and a subcommand that runs no script file yields no script", () => {
        const bun = "/opt/bun/bin/bun";
        expect(scriptOf("bun run pi.ts", "/work", bun)).toBe("/work/pi.ts");
        expect(scriptOf("bun run evil.ts", "/work", bun)).toBe("/work/evil.ts");
        expect(scriptOf("bun --smol run --hot /opt/pi/cli.ts", null, bun)).toBe("/opt/pi/cli.ts");
        expect(scriptOf("deno run -A /opt/pi/main.ts", null, "/usr/local/bin/deno")).toBe("/opt/pi/main.ts");
        expect(scriptOf("bun x some-package", "/work", bun)).toBeNull();
        expect(scriptOf("bun test", "/work", bun)).toBeNull();
        expect(scriptOf("bun /opt/pi/cli.ts", null, bun)).toBe("/opt/pi/cli.ts");
        // The kernel's executable decides, so an argv[0] renamed away from "bun" still skips `run`.
        expect(scriptOf("worker run pi.ts", "/work", bun)).toBe("/work/pi.ts");
        // A flag after `run` is a flag before the script, so it blocks remembering like one before `run`.
        expect(codeInjectionSignals("bun run --preload ./evil.ts pi.ts", null, bun)).toEqual(["flag --preload"]);
    });

    test("a native client with a loader variable is never remembered; an interpreter variable does not count", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "/opt/pi/bin/pi"),
            row(701, 600, "/opt/pi/bin/pi"),
            row(800, 700, "tools"),
            row(801, 701, "tools"),
        ];
        const lookup = lookupOf(
            rows,
            {},
            { 700: "/opt/pi/bin/pi", 701: "/opt/pi/bin/pi" },
            {
                700: "/opt/pi/bin/pi HOME=/Users/x DYLD_INSERT_LIBRARIES=/tmp/x.dylib",
                701: "/opt/pi/bin/pi HOME=/Users/x PYTHONPATH=/opt/lib NODE_OPTIONS=--max-old-space-size=4096",
            }
        );
        const injectedLoader = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        const plain = describeClient({ name: "pi", pid: 701 }, lookup, 801);

        expect(injectedLoader).toMatchObject({
            isAncestor: true,
            injected: ["env DYLD_INSERT_LIBRARIES"],
            verified: false,
        });
        expect(injectedLoader.key).toBe(clientKey("pi", null));
        expect(plain).toMatchObject({ injected: [], verified: true });
    });

    test("replacing the approved binary or script at the same path changes the key; an unstampable file is unverified", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "node /opt/pi/cli.js"),
            row(800, 700, "tools"),
        ];
        const executables = { 700: "/usr/bin/node" };
        const identify = (stampOf: (path: string) => string | null) =>
            describeClient({ name: "pi", pid: 700 }, lookupOf(rows, {}, executables, undefined, stampOf), 800);

        const approved = identify((path) => `v1:${path}`);
        const scriptSwapped = identify((path) => (path === "/opt/pi/cli.js" ? "v2:/opt/pi/cli.js" : `v1:${path}`));
        const binarySwapped = identify((path) => (path === "/usr/bin/node" ? "v2:/usr/bin/node" : `v1:${path}`));
        const unreadable = identify((path) => (path === "/opt/pi/cli.js" ? null : `v1:${path}`));

        expect([approved.verified, scriptSwapped.verified, binarySwapped.verified]).toEqual([true, true, true]);
        expect(new Set([approved.key, scriptSwapped.key, binarySwapped.key]).size).toBe(3);
        expect(unreadable).toMatchObject({ isAncestor: true, verified: false, key: clientKey("pi", null) });
    });

    test("the real stamp changes when a file is replaced at the same path", () => {
        const dir = mkdtempSync(join(tmpdir(), "gate-stamp-"));

        try {
            const path = join(dir, "cli.js");
            writeFileSync(path, "console.log(1)\n");
            const before = fileStamps([path]).get(path);
            writeFileSync(join(dir, "next.js"), "console.log(2)\n");
            renameSync(join(dir, "next.js"), path);
            const after = fileStamps([path]).get(path);

            expect(before).toBeString();
            expect(after).toBeString();
            expect(after).not.toBe(before);
            expect(fileStamps([join(dir, "missing.js")]).size).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a client whose environment ps could not read is never remembered", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "/opt/pi/bin/pi"),
            row(800, 700, "tools"),
        ];
        const unread = describeClient({ name: "pi", pid: 700 }, lookupOf(rows, {}, { 700: "/opt/pi/bin/pi" }, {}), 800);
        const read = describeClient({ name: "pi", pid: 700 }, lookupOf(rows, {}, { 700: "/opt/pi/bin/pi" }), 800);

        expect(unread).toMatchObject({ isAncestor: true, injected: [], verified: false });
        expect(unread.key).toBe(clientKey("pi", null));
        expect(read.verified).toBe(true);
    });

    test("two bun scripts in one directory get different keys", () => {
        const rows = [
            row(1, 0, "/sbin/launchd"),
            row(600, 1, "-zsh"),
            row(700, 600, "bun run pi.ts"),
            row(701, 600, "bun run evil.ts"),
            row(800, 700, "tools"),
            row(801, 701, "tools"),
        ];
        const lookup = lookupOf(
            rows,
            { 700: "/work", 701: "/work" },
            { 700: "/opt/bun/bin/bun", 701: "/opt/bun/bin/bun" }
        );
        const pi = describeClient({ name: "pi", pid: 700 }, lookup, 800);
        const evil = describeClient({ name: "pi", pid: 701 }, lookup, 801);

        expect([pi.script, evil.script]).toEqual(["/work/pi.ts", "/work/evil.ts"]);
        expect(pi.verified && evil.verified).toBe(true);
        expect(evil.key).not.toBe(pi.key);
    });
});
