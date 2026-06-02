import { describe, expect, it } from "bun:test";
import { DASH, formatBytes, formatCapturedAt, restoreOutcomeLine, summaryLine } from "@/features/tmux-presets/units";

describe("tmux-presets units — summaryLine", () => {
    it("singular-aware: 1 → no plural, otherwise plural", () => {
        expect(summaryLine({ sessions: 1, windows: 1, panes: 1 })).toBe("1 session · 1 window · 1 pane");
        expect(summaryLine({ sessions: 3, windows: 7, panes: 12 })).toBe("3 sessions · 7 windows · 12 panes");
        expect(summaryLine({ sessions: 0, windows: 0, panes: 0 })).toBe("0 sessions · 0 windows · 0 panes");
    });
});

describe("tmux-presets units — formatBytes", () => {
    it("em-dash on 0/negative, B/KB/MB scaling", () => {
        expect(formatBytes(0)).toBe(DASH);
        expect(formatBytes(-5)).toBe(DASH);
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(4096)).toBe("4.0 KB");
        expect(formatBytes(2_097_152)).toBe("2.0 MB");
    });
});

describe("tmux-presets units — formatCapturedAt", () => {
    it("valid ISO → non-dash, garbage → em-dash", () => {
        expect(formatCapturedAt(new Date().toISOString())).not.toBe(DASH);
        expect(formatCapturedAt("nope")).toBe(DASH);
    });
});

describe("tmux-presets units — restoreOutcomeLine", () => {
    it("omits failed when 0, appends when > 0", () => {
        expect(restoreOutcomeLine({ created: 2, skipped: 1, failed: 0 })).toBe("2 created · 1 skipped");
        expect(restoreOutcomeLine({ created: 1, skipped: 0, failed: 2 })).toBe("1 created · 0 skipped · 2 failed");
    });
});
