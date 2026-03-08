import { describe, expect, it } from "bun:test";
import { parseDate, parseDateRange } from "../DateParser";

describe("DateParser", () => {
    it("parses ISO dates", () => {
        const d = parseDate("2024-01-15");
        expect(d).toBeInstanceOf(Date);
        expect(d!.getFullYear()).toBe(2024);
    });

    it("parses natural language 'yesterday'", () => {
        const d = parseDate("yesterday");
        expect(d).toBeInstanceOf(Date);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        expect(d!.toDateString()).toBe(yesterday.toDateString());
    });

    it("parses '3 days ago'", () => {
        const d = parseDate("3 days ago");
        expect(d).toBeInstanceOf(Date);
    });

    it("parses 'last week'", () => {
        const d = parseDate("last week");
        expect(d).toBeInstanceOf(Date);
    });

    it("returns null for unparseable input", () => {
        const d = parseDate("not a date at all xyz");
        expect(d).toBeNull();
    });

    it("parseDateRange handles 'since X until Y'", () => {
        const range = parseDateRange({ since: "2024-01-01", until: "2024-01-31" });
        expect(range.since).toBeInstanceOf(Date);
        expect(range.until).toBeInstanceOf(Date);
        expect(range.since!.getMonth()).toBe(0);
    });

    it("parseDateRange handles natural language", () => {
        const range = parseDateRange({ since: "last week" });
        expect(range.since).toBeInstanceOf(Date);
        expect(range.until).toBeUndefined();
    });
});
