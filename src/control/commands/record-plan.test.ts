import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishRecordedPlan } from "./record-plan";

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
