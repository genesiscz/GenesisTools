import { describe, it, expect } from "bun:test";
import { Storage } from "./storage";

describe("Storage.parseTTL", () => {
    const storage = new Storage("test-tool");

    describe("singular units", () => {
        it("parses seconds", () => {
            expect(storage.parseTTL("1 second")).toBe(1000);
        });

        it("parses minutes", () => {
            expect(storage.parseTTL("1 minute")).toBe(60000);
            expect(storage.parseTTL("5 minute")).toBe(300000);
        });

        it("parses hours", () => {
            expect(storage.parseTTL("1 hour")).toBe(3600000);
        });

        it("parses days", () => {
            expect(storage.parseTTL("1 day")).toBe(86400000);
            expect(storage.parseTTL("5 day")).toBe(432000000);
        });

        it("parses weeks", () => {
            expect(storage.parseTTL("1 week")).toBe(604800000);
        });
    });

    describe("plural units", () => {
        it("parses all plural forms", () => {
            expect(storage.parseTTL("30 seconds")).toBe(30000);
            expect(storage.parseTTL("5 minutes")).toBe(300000);
            expect(storage.parseTTL("2 hours")).toBe(7200000);
            expect(storage.parseTTL("5 days")).toBe(432000000);
            expect(storage.parseTTL("2 weeks")).toBe(1209600000);
        });
    });

    describe("without space", () => {
        it("parses without space between number and unit", () => {
            expect(storage.parseTTL("5days")).toBe(432000000);
            expect(storage.parseTTL("1hour")).toBe(3600000);
        });
    });

    describe("case insensitivity", () => {
        it("parses uppercase units", () => {
            expect(storage.parseTTL("5 DAYS")).toBe(432000000);
            expect(storage.parseTTL("1 HOUR")).toBe(3600000);
        });
    });

    describe("invalid formats", () => {
        it("throws for invalid format", () => {
            expect(() => storage.parseTTL("invalid")).toThrow("Invalid TTL format");
        });

        it("throws for empty string", () => {
            expect(() => storage.parseTTL("")).toThrow("Invalid TTL format");
        });

        it("throws for unsupported units", () => {
            expect(() => storage.parseTTL("5 months")).toThrow("Invalid TTL format");
        });
    });
});
