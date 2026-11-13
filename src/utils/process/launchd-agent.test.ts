import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    _setLaunchAgentsDirForTests,
    _setLaunchctlRunnerForTests,
    installLaunchd,
    LAUNCHCTL_TIMEOUT_EXIT_CODE,
    type LaunchctlResult,
    type LaunchdInstallOptions,
    launchdStatus,
    parseLaunchdPid,
    plistPath,
    renderLaunchdPlist,
    runLaunchctlCommand,
} from "@genesiscz/utils/process/launchd-agent";
import { skip } from "@genesiscz/utils/test/skip";

const LABEL = "com.genesis-tools.test.launchd-agent";
const ok: LaunchctlResult = { exitCode: 0, stdout: "", stderr: "" };

function baseOptions(): LaunchdInstallOptions {
    return { label: LABEL, command: ["/usr/bin/true"], logFile: "/tmp/agent.log" };
}

/** `<key>K</key>` followed by its `<string>` value, in the shared writer's two-line layout. */
function plistString(plist: string, key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe("renderLaunchdPlist", () => {
    // No GenesisTools.app launcher, so ProgramArguments is the bare command.
    const noApp = { GENESIS_TOOLS_APP_HOME: "/nonexistent", GENESIS_TOOLS_NO_APP: "1" };

    test("one logFile feeds both streams; logPaths splits them", async () => {
        await env.testing.withOverrides(noApp, () => {
            const single = renderLaunchdPlist(baseOptions());
            expect(plistString(single, "StandardOutPath")).toBe("/tmp/agent.log");
            expect(plistString(single, "StandardErrorPath")).toBe("/tmp/agent.log");

            const split = renderLaunchdPlist({
                label: LABEL,
                command: ["/usr/bin/true"],
                logPaths: { stdout: "/tmp/out.log", stderr: "/tmp/err.log" },
            });
            expect(plistString(split, "StandardOutPath")).toBe("/tmp/out.log");
            expect(plistString(split, "StandardErrorPath")).toBe("/tmp/err.log");
        });
    });

    test("processType becomes the ProcessType key, and no key is written without it", async () => {
        await env.testing.withOverrides(noApp, () => {
            expect(plistString(renderLaunchdPlist({ ...baseOptions(), processType: "Standard" }), "ProcessType")).toBe(
                "Standard"
            );
            expect(renderLaunchdPlist(baseOptions())).not.toContain("<key>ProcessType</key>");
        });
    });

    test("the default PATH names the Homebrew prefix and the command's folder", async () => {
        await env.testing.withOverrides(noApp, () => {
            const path = plistString(renderLaunchdPlist(baseOptions()), "PATH") ?? "";
            expect(path.split(":")).toContain("/opt/homebrew/bin");
            expect(path.split(":")).toContain("/usr/bin");
        });
    });
});

describe("parseLaunchdPid", () => {
    test("reads the plain `pid = N` line of launchctl print", () => {
        const print = `gui/501/${LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 9932\n\tjob state = running\n}`;
        expect(parseLaunchdPid(print)).toBe(9932);
    });

    test('reads the dict form `"PID" = N;` of launchctl list <label>', () => {
        const list = `{\n\t"Label" = "${LABEL}";\n\t"LastExitStatus" = 0;\n\t"PID" = 4242;\n};`;
        expect(parseLaunchdPid(list)).toBe(4242);
    });

    test("a loaded job that is not running has no pid", () => {
        expect(parseLaunchdPid(`gui/501/${LABEL} = {\n\tstate = not running\n\tlast exit code = 0\n}`)).toBeUndefined();
    });
});

describe.skipIf(skip.unlessMac)("launchd agent through the fake runner", () => {
    let agentsDir = "";
    let calls: string[][] = [];

    beforeEach(() => {
        agentsDir = mkdtempSync(join(tmpdir(), "gt-launchd-agent-"));
        _setLaunchAgentsDirForTests(agentsDir);
        calls = [];
    });

    afterEach(() => {
        _setLaunchctlRunnerForTests(null);
        _setLaunchAgentsDirForTests(null);
        rmSync(agentsDir, { recursive: true, force: true });
    });

    function runner(answer: (args: readonly string[], index: number) => LaunchctlResult): void {
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);
            return answer(args, calls.length - 1);
        });
    }

    test("launchdStatus reads the pid from launchctl print, in either form", async () => {
        runner(() => ({ ...ok, stdout: "\tstate = running\n\tpid = 321\n" }));
        expect(await launchdStatus(LABEL)).toEqual({ loaded: true, pid: 321 });
        expect(calls[0]?.[0]).toBe("print");
        expect(calls[0]?.[1]).toEndWith(`/${LABEL}`);

        runner(() => ({ ...ok, stdout: '{\n\t"PID" = 654;\n};' }));
        expect(await launchdStatus(LABEL)).toEqual({ loaded: true, pid: 654 });
    });

    test("launchdStatus: loaded without a pid, and not loaded when print fails", async () => {
        runner(() => ({ ...ok, stdout: "\tstate = not running\n" }));
        expect(await launchdStatus(LABEL)).toEqual({ loaded: true });

        runner(() => ({ exitCode: 113, stdout: "", stderr: `Could not find service "${LABEL}"` }));
        expect(await launchdStatus(LABEL)).toEqual({ loaded: false });
    });

    test("a failed load writes the previous plist back, with its mode, and loads it again", async () => {
        const path = plistPath(LABEL);
        const previous = "<plist>the previous agent</plist>\n";
        writeFileSync(path, previous);
        chmodSync(path, 0o644);
        runner((args, index) =>
            args[0] === "load" && index === 1
                ? { exitCode: 5, stdout: "", stderr: "Load failed: 5: Input/output error" }
                : ok
        );

        await expect(installLaunchd(baseOptions())).rejects.toThrow("Input/output error");

        expect(readFileSync(path, "utf8")).toBe(previous);
        expect(statSync(path).mode & 0o777).toBe(0o644);
        expect(calls.map((call) => call[0])).toEqual(["unload", "load", "load"]);
    });

    test("a failed restore load still throws the original error and keeps the previous bytes", async () => {
        const path = plistPath(LABEL);
        writeFileSync(path, "<plist>old</plist>");
        runner((args) => (args[0] === "load" ? { exitCode: 5, stdout: "", stderr: "first failure" } : ok));

        await expect(installLaunchd(baseOptions())).rejects.toThrow("first failure");
        expect(readFileSync(path, "utf8")).toBe("<plist>old</plist>");
    });

    test("a successful install replaces the plist at 0600 and kickstarts unless told not to", async () => {
        const path = plistPath(LABEL);
        writeFileSync(path, "<plist>old</plist>");
        runner(() => ok);

        await installLaunchd(baseOptions());
        expect(readFileSync(path, "utf8")).toContain(`<string>${LABEL}</string>`);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(calls.map((call) => call[0])).toEqual(["unload", "load", "kickstart"]);

        calls = [];
        await installLaunchd(baseOptions(), { kickstart: false });
        expect(calls.map((call) => call[0])).toEqual(["unload", "load"]);
    });

    test("a first install with a failed load leaves nothing to restore and throws", async () => {
        runner((args) => (args[0] === "load" ? { exitCode: 5, stdout: "", stderr: "nope" } : ok));

        await expect(installLaunchd(baseOptions())).rejects.toThrow("nope");
        expect(calls.map((call) => call[0])).toEqual(["unload", "load"]);
    });
});

describe("runLaunchctlCommand", () => {
    test("ends a command that outlives its deadline with the timeout exit code and says so", async () => {
        const started = Date.now();
        const result = await runLaunchctlCommand(["sleep", "30"], 300);

        expect(result.exitCode).toBe(LAUNCHCTL_TIMEOUT_EXIT_CODE);
        expect(result.stderr).toContain("timed out after 300 ms");
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test("returns the output and exit code of a command that finishes in time", async () => {
        const result = await runLaunchctlCommand(["sh", "-c", "echo out; echo err >&2; exit 3"], 5_000);

        expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    });
});
