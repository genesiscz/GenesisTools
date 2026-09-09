import { expect, test } from "bun:test";
import { parseHistoryDate } from "./history-date";

test("shared history dates support Claude's relative and named syntax", () => {
    const now = new Date(2026, 8, 8, 12, 30);
    expect(parseHistoryDate({ value: "1 week ago", now }).getDate()).toBe(1);
    expect(parseHistoryDate({ value: "2 hours ago", now }).getHours()).toBe(10);
    expect(parseHistoryDate({ value: "yesterday", now }).getDate()).toBe(7);
    expect(parseHistoryDate({ value: "today", now }).getHours()).toBe(0);
    // Changed deliberately: this used to assert UTC midnight, which disagreed with `today` and
    // `yesterday` above by the machine's UTC offset. A typed calendar day is the caller's day.
    expect(parseHistoryDate({ value: "2026-09-01", now })).toEqual(new Date(2026, 8, 1));
    expect(parseHistoryDate({ value: "2026-09-08", now })).toEqual(parseHistoryDate({ value: "today", now }));
    expect(() => parseHistoryDate({ value: "not-a-date", now })).toThrow();
});

test("a month subtraction lands in the intended month instead of rolling forward", () => {
    // Date.setMonth clamps by rolling forward, so 31 March minus one month became 3 March: the
    // window moved 28 days the wrong way and `--since '1 month ago'` returned almost nothing.
    expect(parseHistoryDate({ value: "1 month ago", now: new Date(2026, 2, 31, 12) })).toEqual(
        new Date(2026, 1, 28, 12)
    );
    expect(parseHistoryDate({ value: "3 months ago", now: new Date(2026, 4, 31, 12) })).toEqual(
        new Date(2026, 1, 28, 12)
    );
    expect(parseHistoryDate({ value: "1 month ago", now: new Date(2026, 8, 8, 12) })).toEqual(new Date(2026, 7, 8, 12));
    // A leap February still takes the 29th.
    expect(parseHistoryDate({ value: "1 month ago", now: new Date(2028, 2, 31, 12) })).toEqual(
        new Date(2028, 1, 29, 12)
    );
});
