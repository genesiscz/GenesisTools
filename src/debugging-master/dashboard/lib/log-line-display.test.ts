import { describe, expect, it } from "bun:test";
import { filterDisplayLogLines, isBlankLogLine, shouldShowLogTimestamp, visibleLogText } from "./log-line-display";

describe("log-line-display", () => {
    it("treats whitespace and bare carriage returns as blank", () => {
        expect(isBlankLogLine({ msg: "\r" })).toBe(true);
        expect(isBlankLogLine({ msg: "   " })).toBe(true);
        expect(isBlankLogLine({ msgAnsi: "\u001b[2m\u001b[22m\r" })).toBe(true);
    });

    it("keeps visible ansi lines", () => {
        expect(visibleLogText({ msgAnsi: "\u001b[32mgreen\u001b[0m" })).toBe("green");
        expect(isBlankLogLine({ msgAnsi: "\u001b[32mgreen\u001b[0m" })).toBe(false);
    });

    it("filters blank lines from lists", () => {
        const lines = [{ msg: "ok" }, { msg: "\r" }, { msg: "next" }];
        expect(filterDisplayLogLines(lines)).toEqual([{ msg: "ok" }, { msg: "next" }]);
    });

    it("treats dbg dump labels as visible when msg is empty", () => {
        const entry = { level: "dump", label: "authAuthenticateSaga-tick", msg: "" };
        expect(visibleLogText(entry)).toBe("authAuthenticateSaga-tick");
        expect(isBlankLogLine(entry)).toBe(false);
        expect(filterDisplayLogLines([entry])).toEqual([entry]);
    });

    describe("shouldShowLogTimestamp", () => {
        const t1 = Date.parse("2026-01-01T12:00:00.000");
        const t2 = Date.parse("2026-01-01T12:00:00.001");
        const t3 = Date.parse("2026-01-01T12:00:01.000");

        it("always shows in every mode", () => {
            expect(shouldShowLogTimestamp({ mode: "every", ts: t1 })).toBe(true);
            expect(shouldShowLogTimestamp({ mode: "every", ts: t2, previousTs: t1 })).toBe(true);
        });

        it("never shows in never mode", () => {
            expect(shouldShowLogTimestamp({ mode: "never", ts: t1 })).toBe(false);
            expect(shouldShowLogTimestamp({ mode: "never", ts: t2, previousTs: t3 })).toBe(false);
        });

        it("shows on first line and when formatted time changes in change mode", () => {
            expect(shouldShowLogTimestamp({ mode: "change", ts: t1 })).toBe(true);
            expect(shouldShowLogTimestamp({ mode: "change", ts: t1, previousTs: t1 })).toBe(false);
            expect(shouldShowLogTimestamp({ mode: "change", ts: t2, previousTs: t1 })).toBe(true);
            expect(shouldShowLogTimestamp({ mode: "change", ts: t3, previousTs: t2 })).toBe(true);
        });
    });
});
