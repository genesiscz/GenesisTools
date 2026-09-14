import type { ClassifiedLogEntry } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { errorCount, firstErrorIndex, lineText, toClassifiedLines } from "@/features/build-log-tail/units";

const e = (over: Partial<ClassifiedLogEntry>): ClassifiedLogEntry =>
    ({ type: "stdout", ts: "t", data: "x", cls: "info", ...over }) as ClassifiedLogEntry;

describe("toClassifiedLines", () => {
    it("indexes entries in order and preserves cls", () => {
        const lines = toClassifiedLines([e({ data: "a" }), e({ data: "b", cls: "error" })]);
        expect(lines.map((l) => l.index)).toEqual([0, 1]);
        expect(lines[1].cls).toBe("error");
    });

    it("re-derives cls when the entry has no server cls (defensive — mock/backlog path)", () => {
        const noCls = { type: "stderr", ts: "t", data: "boom" } as ClassifiedLogEntry;
        expect(toClassifiedLines([noCls])[0].cls).toBe("error");
    });
});

describe("firstErrorIndex / errorCount", () => {
    it("finds the first error index, -1 when none", () => {
        const lines = toClassifiedLines([
            e({ data: "ok" }),
            e({ data: "bad", cls: "error" }),
            e({ data: "bad2", cls: "error" }),
        ]);
        expect(firstErrorIndex(lines)).toBe(1);
        expect(errorCount(lines)).toBe(2);
        expect(firstErrorIndex(toClassifiedLines([e({ data: "ok" })]))).toBe(-1);
    });
});

describe("lineText", () => {
    it("renders a meta header, an exit, and a trimmed data line", () => {
        expect(
            lineText(
                e({
                    type: "meta",
                    taskName: "sync",
                    command: "bun x",
                    attempt: 1,
                    runId: "r",
                    startedAt: "t",
                } as Partial<ClassifiedLogEntry>),
            ),
        ).toContain("sync");
        expect(lineText(e({ type: "exit", code: 1, duration_ms: 8000 } as Partial<ClassifiedLogEntry>))).toContain(
            "exit 1",
        );
        expect(lineText(e({ data: "hello\n\n" }))).toBe("hello");
    });
});
