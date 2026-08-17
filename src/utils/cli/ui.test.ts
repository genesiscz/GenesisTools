import { describe, expect, test } from "bun:test";
import { ui } from "./ui";

describe("ui (high-density stderr status)", () => {
    test("exposes ok/info/warn/err/dim/header/kv/section/raw functions", () => {
        for (const fn of ["ok", "info", "warn", "err", "dim", "header", "kv", "section", "raw"] as const) {
            expect(typeof ui[fn]).toBe("function");
        }
    });

    test("ok writes a green-prefixed line to stderr", () => {
        // Capture stderr by stubbing process.stderr.write
        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // Stub stderr.write to capture; cast through `unknown` because the multi-overload signature
        // of WriteStream.write doesn't narrow to a single callable cleanly under strict mode.
        process.stderr.write = ((chunk: unknown) => {
            writes.push(typeof chunk === "string" ? chunk : String(chunk));
            return true;
        }) as unknown as typeof process.stderr.write;
        try {
            ui.ok("done");
        } finally {
            process.stderr.write = orig;
        }
        expect(writes.join("")).toContain("done");
        expect(writes.join("")).toContain("✓"); // chalk green checkmark in output
    });

    test("kv pads keys to keyWidth", () => {
        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // Stub stderr.write to capture; cast through `unknown` because the multi-overload signature
        // of WriteStream.write doesn't narrow to a single callable cleanly under strict mode.
        process.stderr.write = ((chunk: unknown) => {
            writes.push(typeof chunk === "string" ? chunk : String(chunk));
            return true;
        }) as unknown as typeof process.stderr.write;
        try {
            ui.kv("a", "1");
        } finally {
            process.stderr.write = orig;
        }
        // Default keyWidth = 9 → "  a        1\n"  (2 leading spaces, key padded to 9, then value)
        expect(writes.join("")).toMatch(/ {2}a {8}1/);
    });

    // padEnd gives no separator once the key IS keyWidth, so a 9-character key ran straight
    // into its value: `remaining2 → resume at index 0`. Short keys must keep their column,
    // because callers hand-pad continuation lines to line up with it.
    test("kv separates a key that fills the whole width, without moving shorter ones", () => {
        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => {
            writes.push(typeof chunk === "string" ? chunk : String(chunk));
            return true;
        }) as unknown as typeof process.stderr.write;
        try {
            ui.kv("remaining", "40");
            ui.kv("toolongforthecolumn", "x");
            ui.kv("short", "y");
        } finally {
            process.stderr.write = orig;
        }

        const out = writes.join("");
        expect(out).toContain("remaining 40");
        expect(out).not.toMatch(/remaining40/);
        expect(out).toContain("toolongforthecolumn x");
        // Unchanged: 5-character key still padded to the same column as before.
        expect(out).toMatch(/ {2}short {4}y/);
    });
});
