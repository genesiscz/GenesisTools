import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityToSteps, finishRecordedPlan } from "./record-plan";

const SESSION = '{"mode":"commands","startedAt":1760000000000}';
const PLAN = '{\n  "steps": []\n}';

/** `stop` removed the session marker before it wrote the plan, so a failed write lost the recording. */
describe("finishRecordedPlan", () => {
    test("a plan write that fails keeps the session marker for a retry", () => {
        const dir = mkdtempSync(join(tmpdir(), "record-plan-"));
        const sessionPath = join(dir, "session.json");
        writeFileSync(sessionPath, SESSION);
        // A regular file where the plan's folder should be: the write cannot succeed.
        const blocker = join(dir, "blocker");
        writeFileSync(blocker, "not a folder");

        expect(() =>
            finishRecordedPlan({ planJson: PLAN, outPath: join(blocker, "plan.json"), sessionPath })
        ).toThrow();
        expect(readFileSync(sessionPath, "utf8")).toBe(SESSION);
    });

    test("a plan write that succeeds ends the session", () => {
        const dir = mkdtempSync(join(tmpdir(), "record-plan-"));
        const sessionPath = join(dir, "session.json");
        writeFileSync(sessionPath, SESSION);
        const outPath = join(dir, "plan.json");

        finishRecordedPlan({ planJson: PLAN, outPath, sessionPath });

        expect(readFileSync(outPath, "utf8")).toBe(`${PLAN}\n`);
        expect(existsSync(sessionPath)).toBe(false);
    });
});

describe("recorded shortcuts", () => {
    test("physical positions and Shift survive recording on QWERTZ and AZERTY layouts", () => {
        const steps = activityToSteps(
            [
                { type: "key", ts: 10, keycode: 16, char: "z", mods: ["cmd"], app: "Editor" },
                { type: "key", ts: 20, keycode: 12, char: "a", mods: ["cmd"], app: "Editor" },
                { type: "key", ts: 30, keycode: 16, char: "Z", mods: ["cmd", "shift"], app: "Editor" },
                { type: "key", ts: 40, keycode: 43, char: ";", mods: ["ctrl", "alt"], app: "Editor" },
            ],
            1000
        );
        expect(steps.map((entry) => entry.step)).toEqual([
            { do: "hotkey", keys: "cmd,code:16", app: "Editor" },
            { do: "hotkey", keys: "cmd,code:12", app: "Editor" },
            { do: "hotkey", keys: "cmd,shift,code:16", app: "Editor" },
            { do: "hotkey", keys: "ctrl,alt,code:43", app: "Editor" },
        ]);
        expect(steps.map((entry) => entry.ts)).toEqual([1010, 1020, 1030, 1040]);
    });
});
