import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    _setLaunchAgentsDirForTests,
    _setLaunchctlRunnerForTests,
    startLaunchd,
} from "@genesiscz/utils/process/launchd-agent";
import { skip } from "@genesiscz/utils/test/skip";

const LABEL = "com.genesis-tools.test.start-idempotent";
let agentsDir = "";
let plist = "";

beforeEach(() => {
    // The plist goes into a scratch folder: one left in the real ~/Library/LaunchAgents loads at the next login.
    agentsDir = mkdtempSync(join(tmpdir(), "gt-launchd-start-"));
    plist = join(agentsDir, `${LABEL}.plist`);
    _setLaunchAgentsDirForTests(agentsDir);
});

afterEach(() => {
    _setLaunchctlRunnerForTests(null);
    _setLaunchAgentsDirForTests(null);
    rmSync(agentsDir, { recursive: true, force: true });
});

describe.skipIf(skip.unlessMac)("startLaunchd", () => {
    test("an already-loaded agent is unloaded first, so `load` cannot fail on it", async () => {
        // The normal post-boot state: RunAtLoad loaded the plist, the process
        // then crashed and sits in its 10 s throttle window. A bare
        // `launchctl load` exits non-zero with "service already loaded", and
        // `tools ai-proxy up` used to abort on it instead of kickstarting.
        writeFileSync(plist, "<plist/>");

        const calls: string[][] = [];
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);

            if (args[0] === "load" && !calls.some((call) => call[0] === "unload")) {
                return { exitCode: 1, stdout: "", stderr: `${plist}: service already loaded` };
            }

            return { exitCode: 0, stdout: "", stderr: "" };
        });

        await startLaunchd(LABEL);

        expect(calls.map((call) => call[0])).toEqual(["unload", "load", "kickstart"]);
    });

    test("a genuine load failure still throws", async () => {
        writeFileSync(plist, "<plist/>");
        _setLaunchctlRunnerForTests(async (args) =>
            args[0] === "load"
                ? { exitCode: 2, stdout: "", stderr: "Load failed: 5: Input/output error" }
                : { exitCode: 0, stdout: "", stderr: "" }
        );

        await expect(startLaunchd(LABEL)).rejects.toThrow("Input/output error");
    });

    test("a missing plist errors before any launchctl call", async () => {
        const calls: string[][] = [];
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);
            return { exitCode: 0, stdout: "", stderr: "" };
        });

        await expect(startLaunchd("com.genesis-tools.test.no-such-agent")).rejects.toThrow("launchd plist missing");
        expect(calls).toEqual([]);
    });
});
