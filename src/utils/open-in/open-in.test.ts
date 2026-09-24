import { describe, expect, it } from "bun:test";
import { type CmuxOps, cmuxDriver } from "./cmux";
import { cursorArgv, cursorDriver } from "./cursor";
import type { ArgvRunner } from "./types";

describe("cursor driver", () => {
    it("opens the root at file:line:column, or just the root", () => {
        expect(cursorArgv("cursor", { root: "/r", file: "/r/a.ts", line: 12, column: 3 })).toEqual([
            "cursor",
            "/r",
            "--goto",
            "/r/a.ts:12:3",
        ]);
        expect(cursorArgv("cursor", { root: "/r", file: "/r/a.ts" })).toEqual(["cursor", "/r", "--goto", "/r/a.ts"]);
        expect(cursorArgv("cursor", { root: "/r" })).toEqual(["cursor", "/r"]);
    });

    it("spawns the resolved binary with argv and reports a failed exit", async () => {
        const calls: string[][] = [];
        const runner: ArgvRunner = async (argv) => {
            calls.push(argv);
            return { code: calls.length === 1 ? 0 : 1, stdout: "", stderr: "boom" };
        };
        const driver = cursorDriver({ runner, binary: () => "/bin/cursor" });
        await driver.open({ root: "/r", file: "/r/a.ts", line: 1 });
        expect(calls[0]).toEqual(["/bin/cursor", "/r", "--goto", "/r/a.ts:1"]);
        await expect(driver.open({ root: "/r" })).rejects.toThrow("cursor exited 1: boom");
    });

    it("refuses when Cursor is missing", async () => {
        const driver = cursorDriver({ binary: () => null });
        await expect(driver.open({ root: "/r" })).rejects.toThrow("not installed");
    });
});

function fakeCmux(): { ops: CmuxOps; log: string[] } {
    const log: string[] = [];
    return {
        log,
        ops: {
            createWorkspace: async ({ name, cwd }) => {
                log.push(`create ${name ?? "-"} ${cwd}`);
                return { workspaceRef: "workspace:7" };
            },
            selectWorkspace: async (ref) => {
                log.push(`select ${ref}`);
            },
            anchorSurface: async (ref) => {
                log.push(`anchor ${ref}`);
                return { surfaceRef: "surface:9" };
            },
            send: async ({ surfaceRef, text }) => {
                log.push(`send ${surfaceRef} ${text}`);
            },
            settle: async () => {},
        },
    };
}

describe("cmux driver", () => {
    it("selects the new workspace before asking for its anchor, then types one quoted line", async () => {
        const { ops, log } = fakeCmux();
        await cmuxDriver({ ops }).open({ cwd: "/r", title: "app", argv: ["claude", "it's $(x); rm -rf /"] });
        expect(log).toEqual([
            "create app /r",
            "select workspace:7",
            "anchor workspace:7",
            "send surface:9 'claude' 'it'\\''s $(x); rm -rf /'\n",
        ]);
    });

    it("only opens the folder when there is no argv", async () => {
        const { ops, log } = fakeCmux();
        const result = await cmuxDriver({ ops }).open({ cwd: "/r" });
        expect(log).toEqual(["create - /r", "select workspace:7"]);
        expect(result.detail).toBe("workspace:7 at /r");
    });
});
