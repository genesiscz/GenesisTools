import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
    formatDuration, parseDuration, formatRelativeTime,
    formatBytes, formatCost, formatTokens, formatList, formatNumber,
} from "./format";

describe("formatDuration", () => {
    describe("tiered style (default)", () => {
        it("formats sub-second as milliseconds", () => {
            expect(formatDuration(500)).toBe("500ms");
            expect(formatDuration(0)).toBe("0ms");
            expect(formatDuration(999)).toBe("999ms");
        });

        it("formats seconds with one decimal", () => {
            expect(formatDuration(1000)).toBe("1.0s");
            expect(formatDuration(1500)).toBe("1.5s");
        });

        it("formats minutes and seconds", () => {
            expect(formatDuration(60000)).toBe("1m 0s");
            expect(formatDuration(90000)).toBe("1m 30s");
        });

        it("formats hours and minutes", () => {
            expect(formatDuration(3600000)).toBe("1h 0m");
            expect(formatDuration(5400000)).toBe("1h 30m");
        });
    });

    describe("hm-always style", () => {
        it("always shows hours and minutes", () => {
            expect(formatDuration(0, "ms", "hm-always")).toBe("0h 0m");
            expect(formatDuration(90000, "ms", "hm-always")).toBe("0h 1m");
            expect(formatDuration(3661000, "ms", "hm-always")).toBe("1h 1m");
        });
    });

    describe("hm-smart style", () => {
        it("shows '< 1m' for sub-minute", () => {
            expect(formatDuration(30000, "ms", "hm-smart")).toBe("< 1m");
            expect(formatDuration(0, "ms", "hm-smart")).toBe("< 1m");
        });

        it("shows minutes only when under an hour", () => {
            expect(formatDuration(300000, "ms", "hm-smart")).toBe("5m");
        });

        it("shows hours only when minutes are zero", () => {
            expect(formatDuration(3600000, "ms", "hm-smart")).toBe("1h");
        });

        it("shows hours and minutes", () => {
            expect(formatDuration(5400000, "ms", "hm-smart")).toBe("1h 30m");
        });

        it("handles rounding where mins round to 60", () => {
            expect(formatDuration(7170000, "ms", "hm-smart")).toBe("2h");
        });
    });

    describe("hms style", () => {
        it("shows seconds for sub-minute", () => {
            expect(formatDuration(5000, "ms", "hms")).toBe("5s");
        });

        it("shows minutes and seconds", () => {
            expect(formatDuration(65000, "ms", "hms")).toBe("1m 5s");
        });

        it("shows hours, minutes, and seconds", () => {
            expect(formatDuration(3661000, "ms", "hms")).toBe("1h 1m 1s");
        });
    });

    describe("unit conversion", () => {
        it("accepts seconds", () => {
            expect(formatDuration(5, "s")).toBe("5.0s");
            expect(formatDuration(90, "s")).toBe("1m 30s");
        });

        it("accepts minutes", () => {
            expect(formatDuration(1.5, "min")).toBe("1m 30s");
        });
    });
});

describe("parseDuration", () => {
    describe("simple durations", () => {
        it("parses seconds", () => {
            expect(parseDuration("30s")).toBe(30000);
            expect(parseDuration("30sec")).toBe(30000);
            expect(parseDuration("30seconds")).toBe(30000);
        });

        it("parses minutes", () => {
            expect(parseDuration("30m")).toBe(1800000);
            expect(parseDuration("30min")).toBe(1800000);
            expect(parseDuration("30minutes")).toBe(1800000);
        });

        it("parses hours", () => {
            expect(parseDuration("2h")).toBe(7200000);
            expect(parseDuration("2hr")).toBe(7200000);
            expect(parseDuration("2hours")).toBe(7200000);
        });
    });

    describe("compound durations", () => {
        it("parses hours and minutes", () => {
            expect(parseDuration("1h30m")).toBe(5400000);
            expect(parseDuration("2h15min")).toBe(8100000);
        });

        it("parses minutes and seconds", () => {
            expect(parseDuration("20m 1s")).toBe(1201000);
            expect(parseDuration("20m1s")).toBe(1201000);
        });

        it("parses hours, minutes, and seconds", () => {
            expect(parseDuration("1h30m15s")).toBe(5415000);
            expect(parseDuration("1h 30m 15s")).toBe(5415000);
        });
    });

    describe("plain numbers (treated as minutes)", () => {
        it("treats plain numbers as minutes", () => {
            expect(parseDuration("30")).toBe(1800000);
            expect(parseDuration("1")).toBe(60000);
        });
    });

    describe("invalid input", () => {
        it("returns 0 for invalid strings", () => {
            expect(parseDuration("")).toBe(0);
            expect(parseDuration("abc")).toBe(0);
            expect(parseDuration("   ")).toBe(0);
        });
    });
});

describe("formatRelativeTime", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-02-24T12:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("default (verbose) mode", () => {
        it("returns 'just now' for < 1 minute", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:59:30Z"))).toBe("just now");
        });

        it("returns '1 minute ago'", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:59:00Z"))).toBe("1 minute ago");
        });

        it("returns 'N minutes ago'", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:55:00Z"))).toBe("5 minutes ago");
        });

        it("returns '1 hour ago'", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:00:00Z"))).toBe("1 hour ago");
        });

        it("returns 'N hours ago'", () => {
            expect(formatRelativeTime(new Date("2026-02-24T09:00:00Z"))).toBe("3 hours ago");
        });

        it("returns 'N days ago'", () => {
            expect(formatRelativeTime(new Date("2026-02-22T12:00:00Z"))).toBe("2 days ago");
        });

        it("returns '1 day ago' for singular", () => {
            expect(formatRelativeTime(new Date("2026-02-23T12:00:00Z"))).toBe("1 day ago");
        });
    });

    describe("compact mode", () => {
        it("returns 'now' for < 1 minute", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:59:30Z"), { compact: true })).toBe("now");
        });

        it("returns 'Nm ago' for minutes", () => {
            expect(formatRelativeTime(new Date("2026-02-24T11:55:00Z"), { compact: true })).toBe("5m ago");
        });

        it("returns 'Nh ago' for hours", () => {
            expect(formatRelativeTime(new Date("2026-02-24T09:00:00Z"), { compact: true })).toBe("3h ago");
        });

        it("returns 'Nd ago' for days", () => {
            expect(formatRelativeTime(new Date("2026-02-22T12:00:00Z"), { compact: true })).toBe("2d ago");
        });

        it("returns ISO date for >= 7 days", () => {
            expect(formatRelativeTime(new Date("2026-02-10T12:00:00Z"), { compact: true })).toBe("2026-02-10");
        });
    });

    describe("options", () => {
        it("uses fallbackFormat when maxDays exceeded", () => {
            const result = formatRelativeTime(new Date("2026-01-24T12:00:00Z"), {
                maxDays: 7,
                fallbackFormat: (d) => d.toISOString().slice(0, 10),
            });
            expect(result).toBe("2026-01-24");
        });

        it("uses rounding: round", () => {
            const result = formatRelativeTime(new Date("2026-02-24T09:18:00Z"), { rounding: "round" });
            expect(result).toBe("3 hours ago");
        });
    });
});

describe("formatBytes", () => {
    it("formats sub-KB without decimals", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(500)).toBe("500 B");
        expect(formatBytes(1023)).toBe("1023 B");
    });

    it("formats KB", () => {
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats MB", () => {
        expect(formatBytes(1048576)).toBe("1.0 MB");
    });

    it("formats GB", () => {
        expect(formatBytes(1073741824)).toBe("1.0 GB");
    });

    it("formats TB", () => {
        expect(formatBytes(1099511627776)).toBe("1.0 TB");
    });
});

describe("formatCost", () => {
    it("formats with 4 decimal places and dollar sign", () => {
        expect(formatCost(0)).toBe("$0.0000");
        expect(formatCost(1.23456)).toBe("$1.2346");
        expect(formatCost(0.001)).toBe("$0.0010");
    });
});

describe("formatTokens", () => {
    it("formats sub-1000 as plain number", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(999)).toBe("999");
    });

    it("formats thousands with K", () => {
        expect(formatTokens(1000)).toBe("1.0K");
        expect(formatTokens(1500)).toBe("1.5K");
    });

    it("formats millions with M", () => {
        expect(formatTokens(1000000)).toBe("1.0M");
    });
});

describe("formatList", () => {
    it("joins all items when within limit", () => {
        expect(formatList(["a", "b", "c"])).toBe("a, b, c");
    });

    it("truncates with '+N more' when exceeding limit", () => {
        expect(formatList(["a", "b", "c", "d", "e", "f", "g"], 3)).toBe("a, b, c +4 more");
    });

    it("handles exact limit", () => {
        expect(formatList(["a", "b", "c"], 3)).toBe("a, b, c");
    });

    it("handles empty array", () => {
        expect(formatList([])).toBe("");
    });
});

describe("formatNumber", () => {
    it("formats sub-1000 as plain number", () => {
        expect(formatNumber(0)).toBe("0");
        expect(formatNumber(999)).toBe("999");
    });

    it("formats thousands with K", () => {
        expect(formatNumber(1000)).toBe("1.0K");
    });

    it("formats millions with M", () => {
        expect(formatNumber(1000000)).toBe("1.0M");
    });

    it("formats billions with B", () => {
        expect(formatNumber(1000000000)).toBe("1.0B");
    });
});
