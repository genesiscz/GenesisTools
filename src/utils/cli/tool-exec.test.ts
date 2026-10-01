import { describe, expect, it } from "bun:test";
import { planToolExec, type ToolExecInput } from "./tool-exec";

const base: ToolExecInput = {
    launcher: "/Apps/Example.app/Contents/MacOS/Example",
    execPath: "/home/someone/.tools/bin/gt-demo",
    bunArgs: ["--preload", "/repo/a.ts", "/repo/src/demo/index.ts", "list", "--json"],
    orphanWatchdogPreload: "/repo/src/utils/bun/preload-orphan-watchdog.ts",
    detached: false,
    orphaned: false,
    platform: "darwin",
    execDisabled: false,
    dependencyProblem: null,
};

describe("planToolExec", () => {
    it("execs the launcher with the worker and its arguments (a terminal or launchd)", () => {
        expect(planToolExec(base)).toEqual({
            mode: "exec",
            file: base.launcher as string,
            argv: [base.launcher as string, base.execPath, ...base.bunArgs],
        });
    });

    it("execs the worker directly with the orphan watchdog first when the launcher is skipped (an app face)", () => {
        expect(planToolExec({ ...base, launcher: null })).toEqual({
            mode: "exec",
            file: base.execPath,
            argv: [base.execPath, "--preload", base.orphanWatchdogPreload, ...base.bunArgs],
        });
    });

    it("keeps the wrapper as the parent for a detached start, with the launcher still in front", () => {
        const plan = planToolExec({ ...base, detached: true });

        expect(plan.mode).toBe("spawn");
        expect(plan).toMatchObject({ command: base.launcher, args: [base.execPath, ...base.bunArgs] });
    });

    it("spawns when node_modules looks broken, so the reinstall guard can read stderr", () => {
        const plan = planToolExec({ ...base, launcher: null, dependencyProblem: "node_modules is missing" });

        expect(plan).toMatchObject({ mode: "spawn", command: base.execPath, args: base.bunArgs });
        expect(plan.mode === "spawn" && plan.reason).toContain("node_modules is missing");
    });

    it("spawns when the wrapper is already orphaned, so its watchdog still stops the tool", () => {
        expect(planToolExec({ ...base, orphaned: true }).mode).toBe("spawn");
        expect(planToolExec({ ...base, launcher: null, orphaned: true }).mode).toBe("spawn");
    });

    it("spawns on Windows and when GENESIS_TOOLS_NO_EXEC=1", () => {
        expect(planToolExec({ ...base, platform: "win32" }).mode).toBe("spawn");
        expect(planToolExec({ ...base, execDisabled: true }).mode).toBe("spawn");
    });

    it("never adds the watchdog preload on the launcher path or the spawn path", () => {
        for (const input of [base, { ...base, detached: true }, { ...base, launcher: null, detached: true }]) {
            const plan = planToolExec(input);
            const argv = plan.mode === "exec" ? plan.argv : plan.args;

            expect(argv).not.toContain(base.orphanWatchdogPreload);
        }
    });
});
