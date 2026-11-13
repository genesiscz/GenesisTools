import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _setLaunchAgentsDirForTests,
    _setLaunchctlRunnerForTests,
    type LaunchctlResult,
    plistPath,
} from "@genesiscz/utils/process/launchd-agent";
import { skip } from "@genesiscz/utils/test/skip";
import { DAEMON_STDERR_LOG, DAEMON_STDOUT_LOG, generatePlist, getDaemonStatus, installLaunchd } from "./launchd";

const LABEL = "com.genesis-tools.automate";
const ok: LaunchctlResult = { exitCode: 0, stdout: "", stderr: "" };

function plistString(plist: string, key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe("automate launchd plist", () => {
    test("stdout and stderr go to their own files, at Background process type, with Homebrew on PATH", () => {
        const plist = generatePlist();

        expect(plistString(plist, "Label")).toBe(LABEL);
        expect(plistString(plist, "StandardOutPath")).toBe(DAEMON_STDOUT_LOG);
        expect(plistString(plist, "StandardErrorPath")).toBe(DAEMON_STDERR_LOG);
        expect(plistString(plist, "ProcessType")).toBe("Background");
        expect((plistString(plist, "PATH") ?? "").split(":")).toContain("/opt/homebrew/bin");
    });
});

describe.skipIf(skip.unlessMac)("automate launchd agent through the fake runner", () => {
    let agentsDir = "";
    let calls: string[][] = [];

    beforeEach(() => {
        agentsDir = mkdtempSync(join(tmpdir(), "gt-automate-launchd-"));
        _setLaunchAgentsDirForTests(agentsDir);
        calls = [];
    });

    afterEach(() => {
        _setLaunchctlRunnerForTests(null);
        _setLaunchAgentsDirForTests(null);
        rmSync(agentsDir, { recursive: true, force: true });
    });

    function runner(answer: (args: readonly string[]) => LaunchctlResult): void {
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);
            return answer(args);
        });
    }

    test("status reads the pid launchd reports, and an absent plist is not installed", async () => {
        runner(() => ({ ...ok, stdout: "\tstate = running\n\tpid = 777\n" }));
        expect((await getDaemonStatus()).installed).toBe(false);
        expect(calls).toEqual([]);

        writeFileSync(plistPath(LABEL), "<plist/>");
        const status = await getDaemonStatus();
        expect(status).toMatchObject({ installed: true, running: true, pid: 777 });
    });

    test("install restores the previous plist when the load fails, and never kickstarts", async () => {
        writeFileSync(plistPath(LABEL), "<plist>previous automate</plist>");
        let loads = 0;
        runner((args) => {
            if (args[0] === "load") {
                loads++;
                return loads === 1 ? { exitCode: 5, stdout: "", stderr: "Load failed" } : ok;
            }

            return ok;
        });

        await expect(installLaunchd()).rejects.toThrow("Load failed");
        expect(readFileSync(plistPath(LABEL), "utf8")).toBe("<plist>previous automate</plist>");
        expect(calls.map((call) => call[0])).toEqual(["unload", "load", "load"]);
    });
});
