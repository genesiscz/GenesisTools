import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import { _setLaunchctlRunnerForTests, startLaunchd } from "./launchd";

const LABEL = "com.genesis-tools.test.start-idempotent";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

afterEach(() => {
    _setLaunchctlRunnerForTests(null);
    rmSync(PLIST, { force: true });
});

describe.skipIf(skip.unlessMac)("startLaunchd", () => {
    test("an already-loaded agent is unloaded first, so `load` cannot fail on it", async () => {
        // The normal post-boot state: RunAtLoad loaded the plist, the process
        // then crashed and sits in its 10 s throttle window. A bare
        // `launchctl load` exits non-zero with "service already loaded", and
        // `tools ai-proxy up` used to abort on it instead of kickstarting.
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        writeFileSync(PLIST, "<plist/>");

        const calls: string[][] = [];
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);

            if (args[0] === "load" && !calls.some((call) => call[0] === "unload")) {
                return { exitCode: 1, stderr: `${PLIST}: service already loaded` };
            }

            return { exitCode: 0, stderr: "" };
        });

        await startLaunchd(LABEL);

        expect(calls.map((call) => call[0])).toEqual(["unload", "load", "kickstart"]);
    });

    test("a genuine load failure still throws", async () => {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        writeFileSync(PLIST, "<plist/>");
        _setLaunchctlRunnerForTests(async (args) =>
            args[0] === "load"
                ? { exitCode: 2, stderr: "Load failed: 5: Input/output error" }
                : { exitCode: 0, stderr: "" }
        );

        await expect(startLaunchd(LABEL)).rejects.toThrow("Input/output error");
    });

    test("a missing plist errors before any launchctl call", async () => {
        const calls: string[][] = [];
        _setLaunchctlRunnerForTests(async (args) => {
            calls.push([...args]);
            return { exitCode: 0, stderr: "" };
        });

        await expect(startLaunchd("com.genesis-tools.test.no-such-agent")).rejects.toThrow("launchd plist missing");
        expect(calls).toEqual([]);
    });
});
