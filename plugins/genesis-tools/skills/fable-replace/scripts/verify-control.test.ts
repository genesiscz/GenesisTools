import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VerifyControl } from "./types";
import { runVerifyCommand, runVerifyControl, TS_VERIFY_CONTROL } from "./verify-command";

// The verify control writes a known-bad probe into the edited folder and runs the verify command once; a command that
// does not name the probe proves nothing about that folder. `ls` stands in for a check that covers the folder (it
// lists the probe) and `true` for one that does not, because tsc-rs is not on the CI runner. Every case checks that
// the probe is gone afterwards. `echo ran >> runs.log` counts how often the command ran.

const CONTROL: VerifyControl = {
    probeName: "probe-fixture.ts",
    probeContent: "export const probeFixture: number = 1;\n",
    expectInOutput: "probe-fixture.ts",
};
const COUNT_RUNS = "echo ran >> runs.log";

let dir = "";

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-verify-control-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const probeIn = (folder: string, name = CONTROL.probeName): boolean => fs.existsSync(path.join(folder, name));

const runs = (): number => {
    const log = path.join(dir, "runs.log");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
};

describe("runVerifyCommand with a control", () => {
    test("`true` never names the probe: missed, status unknown, the reason, and the real verify does not run", () => {
        const result = runVerifyCommand({ command: "true", cwd: dir, control: CONTROL });
        expect(result.control).toBe("missed");
        expect(result.status).toBe("unknown");
        expect(result.exitCode).toBeNull();
        expect(result.error).toContain("the verify command did not report the probe");
        expect(probeIn(dir)).toBe(false);

        const counted = runVerifyCommand({ command: COUNT_RUNS, cwd: dir, control: CONTROL });
        expect(counted.control).toBe("missed");
        expect(runs()).toBe(1);
        expect(probeIn(dir)).toBe(false);
    });

    test("`ls` with probeDir = cwd is caught, then the real verify runs once more without the probe", () => {
        const result = runVerifyCommand({ command: "ls", cwd: dir, probeDir: dir, control: CONTROL });
        expect(result.control).toBe("caught");
        expect(result.status).toBe("pass");
        expect(result.exitCode).toBe(0);
        expect(result.shown.join("\n")).not.toContain(CONTROL.probeName);
        expect(probeIn(dir)).toBe(false);

        const counted = runVerifyCommand({ command: `ls && ${COUNT_RUNS}`, cwd: dir, control: CONTROL });
        expect(counted.control).toBe("caught");
        expect(runs()).toBe(2);
        expect(probeIn(dir)).toBe(false);
    });

    test("the probe goes into probeDir: a check of another folder misses it", () => {
        const pkg = path.join(dir, "pkg");
        fs.mkdirSync(pkg);
        expect(runVerifyCommand({ command: "ls pkg", cwd: dir, probeDir: pkg, control: CONTROL }).control).toBe(
            "caught"
        );
        expect(runVerifyCommand({ command: "ls", cwd: dir, probeDir: pkg, control: CONTROL }).control).toBe("missed");
        expect(probeIn(pkg)).toBe(false);
        expect(probeIn(dir)).toBe(false);
    });

    test("an existing file of the probe's name is refused and untouched, and nothing runs", () => {
        const existing = path.join(dir, CONTROL.probeName);
        fs.writeFileSync(existing, "keep\n");
        const result = runVerifyCommand({ command: `ls && ${COUNT_RUNS}`, cwd: dir, control: CONTROL });
        expect(result.status).toBe("unknown");
        expect(result.control).toBeUndefined();
        expect(result.error).toContain("already exists");
        expect(fs.readFileSync(existing, "utf8")).toBe("keep\n");
        expect(runs()).toBe(0);
    });
});

describe("runVerifyControl", () => {
    test("a timeout is unknown and the probe is still removed", () => {
        const run = runVerifyControl({ command: "sleep 3", cwd: dir, probeDir: dir, control: CONTROL, timeoutMs: 200 });
        expect(run.state).toBe("unknown");
        expect(run.reason).toContain("timed out");
        expect(probeIn(dir)).toBe(false);
    });

    test("a probe name with a folder in it is refused before anything is written", () => {
        const pkg = path.join(dir, "pkg");
        fs.mkdirSync(pkg);
        const run = runVerifyControl({
            command: COUNT_RUNS,
            cwd: dir,
            probeDir: pkg,
            control: { ...CONTROL, probeName: "../escape.ts" },
        });
        expect(run.state).toBe("unknown");
        expect(fs.readdirSync(dir).sort()).toEqual(["pkg"]);
    });

    test("the TypeScript preset is one line and names its own file", () => {
        expect(TS_VERIFY_CONTROL.probeContent.trim().split("\n")).toHaveLength(1);
        const run = runVerifyControl({ command: "ls", cwd: dir, probeDir: dir, control: TS_VERIFY_CONTROL });
        expect(run.state).toBe("caught");
        expect(probeIn(dir, TS_VERIFY_CONTROL.probeName)).toBe(false);
    });
});
