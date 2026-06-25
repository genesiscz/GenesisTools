// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ or /Users/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { skip } from "@app/utils/test/skip";

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
    const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";

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
    const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";
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
// collapsePath
// ---------------------------------------------------------------------------

describe("paths: collapsePath", () => {
    let collapsePath: typeof import("./paths").collapsePath;
    const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";

    beforeEach(async () => {
        const mod = await import("./paths");
        collapsePath = mod.collapsePath;
    });

    it("collapses home directory to ~", () => {
        expect(collapsePath(home)).toBe("~");
    });

    it("collapses paths under home with ~/", () => {
        expect(collapsePath(`${home}/Projects/foo`)).toBe("~/Projects/foo");
    });

    it("leaves paths outside home unchanged", () => {
        expect(collapsePath("/usr/local/bin")).toBe("/usr/local/bin");
    });

    it("handles home with trailing slash", () => {
        expect(collapsePath(`${home}/`)).toBe("~/");
    });

    it("collapses paths under home with forward slash", () => {
        expect(collapsePath(`${home}/Projects`)).toBe("~/Projects");
    });
});

describe("collapsePathForDisplay", () => {
    let collapsePathForDisplay: typeof import("./paths").collapsePathForDisplay;
    const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";

    beforeEach(async () => {
        const mod = await import("./paths");
        collapsePathForDisplay = mod.collapsePathForDisplay;
    });

    it("leaves paths outside the current home unchanged", () => {
        expect(collapsePathForDisplay("/Users/dev/my-app")).toBe("/Users/dev/my-app");
    });

    it("collapses the current home directory to ~", () => {
        expect(collapsePathForDisplay(home)).toBe("~");
    });

    it("collapses paths under home to ~/...", () => {
        // Avoid double-slash if `home` already ends with one (uncommon, but
        // possible on some test rigs).
        const trimmed = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home;
        expect(collapsePathForDisplay(`${trimmed}/Projects/foo`)).toBe("~/Projects/foo");
    });

    it("collapses Windows backslash home paths to ~/... (bug #11)", () => {
        // Simulate a Windows native path where home is a backslash path.
        // The bug: pre-normalizing the input to POSIX before calling
        // collapsePath() meant the backslash home-prefix check missed.
        // The fix collapses against the original path; this test would
        // have failed against the prior implementation when home contains
        // backslashes. We can't reliably reproduce Windows homedir() here,
        // but we CAN assert that collapsePathForDisplay returns the POSIX
        // form of the leading "~" instead of the raw native path.
        const trimmed = home.endsWith("/") || home.endsWith("\\") ? home.slice(0, -1) : home;
        const result = collapsePathForDisplay(`${trimmed}/some/file.txt`);
        expect(result.startsWith("~/")).toBe(true);
        expect(result).not.toContain("\\");
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
        const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";
        expect(expandTilde("~\\Desktop")).toBe(join(home, "Desktop"));
    });

    it("expandPath handles ~\\ path", () => {
        const home = env.paths.getHome() || env.paths.getUserProfile() || "/mock-home";
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

    it.skipIf(skip.onWindows)("uses single quotes on Unix (default)", async () => {
        restorePlatform();
        const { escapeShellArg } = await import("../utils/string");
        expect(escapeShellArg("hello")).toBe("'hello'");
    });
});

// ---------------------------------------------------------------------------
// tmpdir / tmpPath / makeTempDir — platform-dependent temp root
// ---------------------------------------------------------------------------

describe("paths: tmpdir", () => {
    let tmpdir: typeof import("./paths").tmpdir;
    let tmpPath: typeof import("./paths").tmpPath;
    let makeTempDir: typeof import("./paths").makeTempDir;
    const created: string[] = [];

    beforeEach(async () => {
        const mod = await import("./paths");
        tmpdir = mod.tmpdir;
        tmpPath = mod.tmpPath;
        makeTempDir = mod.makeTempDir;
    });

    afterEach(async () => {
        restorePlatform();
        const { rmSync } = await import("node:fs");

        for (const dir of created.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
    });

    it("defaults to /tmp on macOS (preferRoot implicit true)", () => {
        restorePlatform();

        if (process.platform === "win32") {
            return;
        }

        expect(tmpdir()).toBe("/tmp");
    });

    it("preferRoot:false returns os.tmpdir() ($TMPDIR)", async () => {
        restorePlatform();
        const { tmpdir: osTmpdir } = await import("node:os");
        expect(tmpdir({ preferRoot: false })).toBe(osTmpdir());
    });

    it("falls back to os.tmpdir() on Windows even with preferRoot", async () => {
        const { tmpdir: osTmpdir } = await import("node:os");
        const realOsTmp = osTmpdir();
        mockWindows();
        // On Windows, tmpdir() is os.tmpdir() — preferRoot must not force the
        // hardcoded "/tmp". (Can't assert !startsWith("/tmp") here: mocking
        // process.platform doesn't change what node's os.tmpdir() returns, and
        // on a Linux test host that is genuinely "/tmp".)
        expect(tmpdir()).toBe(realOsTmp);
        expect(tmpdir({ preferRoot: true })).toBe(realOsTmp);
    });

    it("tmpPath joins segments under the temp root", () => {
        restorePlatform();

        if (process.platform === "win32") {
            return;
        }

        expect(tmpPath("genesis", "x.db")).toBe(join("/tmp", "genesis", "x.db"));
    });

    it("makeTempDir creates a unique existing directory under the root", async () => {
        restorePlatform();
        const { existsSync } = await import("node:fs");

        const a = makeTempDir("genesis-paths-test-");
        const b = makeTempDir("genesis-paths-test-");
        created.push(a, b);

        expect(existsSync(a)).toBe(true);
        expect(existsSync(b)).toBe(true);
        expect(a).not.toBe(b);

        if (process.platform !== "win32") {
            expect(a.startsWith("/tmp/genesis-paths-test-")).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// toPosixPath — separator normalization for keys/output
// ---------------------------------------------------------------------------

describe("paths: toPosixPath", () => {
    let toPosixPath: typeof import("./paths").toPosixPath;

    beforeEach(async () => {
        toPosixPath = (await import("./paths")).toPosixPath;
    });

    it("converts backslashes to forward slashes", () => {
        expect(toPosixPath("src\\a\\b.ts")).toBe("src/a/b.ts");
    });

    it("leaves already-POSIX paths unchanged", () => {
        expect(toPosixPath("src/a/b.ts")).toBe("src/a/b.ts");
    });

    it("handles mixed separators", () => {
        expect(toPosixPath("src\\a/b\\c.ts")).toBe("src/a/b/c.ts");
    });

    it("handles empty and separatorless strings", () => {
        expect(toPosixPath("")).toBe("");
        expect(toPosixPath("file.ts")).toBe("file.ts");
    });
});
