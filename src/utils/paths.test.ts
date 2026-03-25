import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

// We need to test with platform overrides, so we import the module fresh per test group.
// For Windows tests, we mock process.platform before importing.

const originalPlatform = process.platform;

function mockWindows(): void {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

function restorePlatform(): void {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}

// ---------------------------------------------------------------------------
// endsWithSep / lastSepIndex — pure string helpers, no platform dependency
// ---------------------------------------------------------------------------

describe("paths: endsWithSep", () => {
    let endsWithSep: typeof import("./paths").endsWithSep;

    beforeEach(async () => {
        const mod = await import("./paths");
        endsWithSep = mod.endsWithSep;
    });

    it("returns true for trailing /", () => {
        expect(endsWithSep("/Users/Martin/")).toBe(true);
    });

    it("returns true for trailing \\", () => {
        expect(endsWithSep("C:\\Users\\Martin\\")).toBe(true);
    });

    it("returns false when no trailing separator", () => {
        expect(endsWithSep("/Users/Martin")).toBe(false);
        expect(endsWithSep("C:\\Users\\Martin")).toBe(false);
    });

    it("returns false for empty string", () => {
        expect(endsWithSep("")).toBe(false);
    });
});

describe("paths: lastSepIndex", () => {
    let lastSepIndex: typeof import("./paths").lastSepIndex;

    beforeEach(async () => {
        const mod = await import("./paths");
        lastSepIndex = mod.lastSepIndex;
    });

    it("finds last / in Unix path", () => {
        expect(lastSepIndex("/Users/Martin/file.txt")).toBe(13);
    });

    it("finds last \\ in Windows path", () => {
        expect(lastSepIndex("C:\\Users\\Martin\\file.txt")).toBe(15);
    });

    it("picks the rightmost separator in mixed paths", () => {
        expect(lastSepIndex("C:\\Users/Martin\\file.txt")).toBe(15);
    });

    it("returns -1 for no separator", () => {
        expect(lastSepIndex("file.txt")).toBe(-1);
    });
});

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------

describe("paths: expandTilde", () => {
    let expandTilde: typeof import("./paths").expandTilde;
    const home = process.env.HOME || process.env.USERPROFILE || "/mock-home";

    beforeEach(async () => {
        const mod = await import("./paths");
        expandTilde = mod.expandTilde;
    });

    it("expands ~/ to home directory", () => {
        const result = expandTilde("~/Documents");
        expect(result).toBe(join(home, "Documents"));
    });

    it("expands bare ~ to home directory", () => {
        expect(expandTilde("~")).toBe(home);
    });

    it("expands ~\\ (Windows backslash) to home directory", () => {
        const result = expandTilde("~\\Documents");
        expect(result).toBe(join(home, "Documents"));
    });

    it("leaves non-tilde paths unchanged", () => {
        expect(expandTilde("/usr/local")).toBe("/usr/local");
        expect(expandTilde("relative/path")).toBe("relative/path");
    });

    it("leaves ~something (no separator) unchanged", () => {
        expect(expandTilde("~admin")).toBe("~admin");
    });
});

// ---------------------------------------------------------------------------
// expandPath
// ---------------------------------------------------------------------------

describe("paths: expandPath", () => {
    let expandPath: typeof import("./paths").expandPath;
    const home = process.env.HOME || process.env.USERPROFILE || "/mock-home";
    const cwd = process.cwd();

    beforeEach(async () => {
        const mod = await import("./paths");
        expandPath = mod.expandPath;
    });

    it("expands ~/ to home + rest", () => {
        expect(expandPath("~/Downloads")).toBe(join(home, "Downloads"));
    });

    it("expands ~\\ to home + rest", () => {
        expect(expandPath("~\\Downloads")).toBe(join(home, "Downloads"));
    });

    it("expands ./ to cwd + rest", () => {
        expect(expandPath("./src/file.ts")).toBe(join(cwd, "src/file.ts"));
    });

    // On macOS/Linux, path.join doesn't normalize \\ to / — that only happens on Windows.
    // We verify the .\ prefix is stripped; the resulting join is platform-dependent.
    it("expands .\\ prefix by stripping it and joining with cwd", () => {
        const result = expandPath(".\\src\\file.ts");
        expect(result.startsWith(cwd)).toBe(true);
        expect(result).toContain("src");
    });

    it("treats bare relative paths as relative to cwd", () => {
        expect(expandPath("src/file.ts")).toBe(join(cwd, "src/file.ts"));
    });

    it("keeps absolute Unix paths unchanged", () => {
        expect(expandPath("/usr/local/bin")).toBe("/usr/local/bin");
    });
});

// ---------------------------------------------------------------------------
// Windows simulation tests
// ---------------------------------------------------------------------------

describe("paths: Windows-specific behavior", () => {
    let expandPath: typeof import("./paths").expandPath;
    let expandTilde: typeof import("./paths").expandTilde;
    let endsWithSep: typeof import("./paths").endsWithSep;
    let lastSepIndex: typeof import("./paths").lastSepIndex;

    beforeEach(async () => {
        // Note: we can't fully simulate Windows path.isAbsolute() on macOS/Linux
        // because path.isAbsolute is platform-dependent at the Node.js level.
        // But we CAN verify our helpers handle Windows path patterns correctly.
        const mod = await import("./paths");
        expandPath = mod.expandPath;
        expandTilde = mod.expandTilde;
        endsWithSep = mod.endsWithSep;
        lastSepIndex = mod.lastSepIndex;
    });

    it("endsWithSep handles Windows trailing backslash", () => {
        expect(endsWithSep("C:\\Users\\Martin\\")).toBe(true);
        expect(endsWithSep("C:\\Users\\Martin")).toBe(false);
    });

    it("lastSepIndex handles Windows backslash paths", () => {
        expect(lastSepIndex("C:\\Users\\file.txt")).toBe(8);
    });

    it("expandTilde handles ~\\ (Windows convention)", () => {
        const home = process.env.HOME || process.env.USERPROFILE || "/mock-home";
        expect(expandTilde("~\\Desktop")).toBe(join(home, "Desktop"));
    });

    it("expandPath handles ~\\ path", () => {
        const home = process.env.HOME || process.env.USERPROFILE || "/mock-home";
        expect(expandPath("~\\Desktop")).toBe(join(home, "Desktop"));
    });

    it("expandPath handles .\\ path", () => {
        const cwd = process.cwd();
        expect(expandPath(".\\src")).toBe(join(cwd, "src"));
    });
});

// ---------------------------------------------------------------------------
// escapeShellArg Windows branch (from string.ts)
// ---------------------------------------------------------------------------

describe("escapeShellArg: Windows (cross-spawn compatible, two-phase)", () => {
    afterEach(() => {
        restorePlatform();
    });

    it("wraps in ^-escaped double quotes on Windows", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("hello")).toBe('^"hello^"');
    });

    it("escapes inner double quotes (Phase 1) then ^-escapes them (Phase 2)", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    });

    it("doubles trailing backslashes (Phase 1)", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("C:\\path\\")).toBe('^"C:\\path\\\\^"');
    });

    it("doubles backslashes before a quote (Phase 1)", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg('a\\"b')).toBe('^"a\\\\\\^"b^"');
    });

    it("leaves mid-string backslashes alone", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("C:\\Users\\Martin")).toBe('^"C:\\Users\\Martin^"');
    });

    it("^-escapes % for cmd.exe variable expansion (Phase 2)", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("100%")).toBe('^"100^%^"');
        expect(escapeShellArg("%PATH%")).toBe('^"^%PATH^%^"');
    });

    it("^-escapes & and | to prevent command injection (Phase 2)", async () => {
        mockWindows();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("foo & bar")).toBe('^"foo^ ^&^ bar^"');
    });

    it("uses single quotes on Unix (default)", async () => {
        restorePlatform();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("hello")).toBe("'hello'");
    });
});
