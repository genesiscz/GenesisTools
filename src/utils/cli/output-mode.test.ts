import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isQuietOutput } from "./output-mode";

describe("isQuietOutput", () => {
    let origIsTTY: boolean | undefined;

    beforeEach(() => {
        origIsTTY = process.stdout.isTTY;
    });

    afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
            value: origIsTTY,
            configurable: true,
        });
    });

    it("returns true when stdout is not a TTY (any format)", () => {
        Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
        expect(isQuietOutput("table")).toBe(true);
        expect(isQuietOutput("json")).toBe(true);
        expect(isQuietOutput(undefined)).toBe(true);
    });

    it("returns true for json/toon on TTY", () => {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        expect(isQuietOutput("json")).toBe(true);
        expect(isQuietOutput("toon")).toBe(true);
    });

    it("returns false for table format on TTY", () => {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        expect(isQuietOutput("table")).toBe(false);
    });

    it("returns false for undefined format on TTY (default human-readable)", () => {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        expect(isQuietOutput(undefined)).toBe(false);
    });
});
