import { describe, expect, it } from "bun:test";
import { InvalidArgumentError } from "commander";
import { durationToCutoff, intOpt } from "./options";

describe("durationToCutoff", () => {
    const parse = durationToCutoff("--changed-within");

    it("returns SECONDS, not milliseconds", () => {
        // The native core compares the cutoff against st_mtime (epoch seconds).
        // Returning ms would land ~50,000 years in the future and exclude every
        // file, so pin the magnitude against a seconds-scale clock.
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoff = parse("24h");

        expect(cutoff).toBeGreaterThan(nowSec - 86400 - 5);
        expect(cutoff).toBeLessThanOrEqual(nowSec);
    });

    it("subtracts the window from now", () => {
        const nowSec = Math.floor(Date.now() / 1000);

        // Allow a couple of seconds of slack for clock movement during the call.
        expect(nowSec - parse("7d")).toBeGreaterThanOrEqual(604800 - 2);
        expect(nowSec - parse("7d")).toBeLessThanOrEqual(604800 + 2);
        expect(nowSec - parse("30m")).toBeGreaterThanOrEqual(1800 - 2);
        expect(nowSec - parse("30m")).toBeLessThanOrEqual(1800 + 2);
    });

    it("orders windows so a longer one reaches further back", () => {
        expect(parse("30d")).toBeLessThan(parse("7d"));
        expect(parse("7d")).toBeLessThan(parse("24h"));
        expect(parse("24h")).toBeLessThan(parse("30m"));
    });

    it("accepts compound durations", () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const elapsed = nowSec - parse("2d6h");

        expect(elapsed).toBeGreaterThanOrEqual(2 * 86400 + 6 * 3600 - 2);
        expect(elapsed).toBeLessThanOrEqual(2 * 86400 + 6 * 3600 + 2);
    });

    it("rejects unparseable durations with the flag name in the message", () => {
        expect(() => parse("nonsense")).toThrow(InvalidArgumentError);
        expect(() => parse("nonsense")).toThrow(/--changed-within must be a duration/);
        expect(() => parse("")).toThrow(InvalidArgumentError);
        expect(() => parse("7 lightyears")).toThrow(InvalidArgumentError);
    });

    it("rejects a zero-length window instead of returning 'now'", () => {
        // parseDuration returns 0 for these, which would make the cutoff `now` and
        // silently match nothing.
        expect(() => parse("0")).toThrow(InvalidArgumentError);
        expect(() => parse("0h")).toThrow(InvalidArgumentError);
    });
});

describe("intOpt", () => {
    it("parses integers", () => {
        expect(intOpt("--threads")("16")).toBe(16);
    });

    it("enforces min and max", () => {
        const threads = intOpt("--threads", { min: 1, max: 1024 });

        expect(threads("1")).toBe(1);
        expect(threads("1024")).toBe(1024);
        expect(() => threads("0")).toThrow(/--threads must be >= 1/);
        expect(() => threads("1025")).toThrow(/--threads must be <= 1024/);
    });

    it("rejects non-integers rather than silently truncating", () => {
        expect(() => intOpt("--depth")("2.5")).toThrow(InvalidArgumentError);
        expect(() => intOpt("--depth")("abc")).toThrow(InvalidArgumentError);
        expect(() => intOpt("--depth")("")).toThrow(InvalidArgumentError);
    });
});
