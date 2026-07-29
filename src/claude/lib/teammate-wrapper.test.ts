import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { shellSingleQuote } from "./shell-quote";
import {
    buildTeammateWrapperScript,
    installTeammateWrapper,
    removeTeammateWrapper,
    resolveClaudeBinaryForTeammates,
    sweepStaleTeammateWrappers,
} from "./teammate-wrapper";

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "teammate-wrapper-test-"));
}

const AUTH = {
    accountName: "max-primary",
    oauthToken: "sk-ant-oat-secret",
    subscriptionType: "max",
};

describe("resolveClaudeBinaryForTeammates", () => {
    let home: string;

    // Saved, not unset: deleting HOME and PATH outright would leave every later
    // test in the same Bun process without a home directory or a search path.
    const originalHome = env.get("HOME");
    const originalPath = env.get("PATH");

    function restore(name: "HOME" | "PATH", value: string | undefined): void {
        if (value === undefined) {
            env.testing.unset(name);
            return;
        }

        env.testing.set(name, value);
    }

    function installClaudeAt(...segments: string[]): string {
        const dir = join(home, ...segments);
        mkdirSync(dir, { recursive: true });
        const bin = join(dir, "claude");
        writeFileSync(bin, "#!/bin/sh\nexit 0\n");
        chmodSync(bin, 0o755);

        // The resolver returns realpathSync(), and on macOS /var is a symlink to
        // /private/var, so the expectation has to be the real path too.
        return realpathSync(bin);
    }

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "gt-teammate-"));
        env.testing.set("HOME", home);
        // An empty PATH removes the machine's own `claude` from the search, so these
        // assertions are about the resolver rather than about this developer's box.
        env.testing.set("PATH", join(home, "empty-bin"));
    });

    afterEach(() => {
        restore("HOME", originalHome);
        restore("PATH", originalPath);
        rmSync(home, { recursive: true, force: true });
    });

    test("prefers ~/.bun/bin and returns an absolute path", () => {
        const bin = installClaudeAt(".bun", "bin");

        expect(resolveClaudeBinaryForTeammates()).toBe(bin);
    });

    test("falls through to ~/.local/bin when the bun path has none", () => {
        const bin = installClaudeAt(".local", "bin");

        expect(resolveClaudeBinaryForTeammates()).toBe(bin);
    });

    test("skips a candidate that exists but is not executable", () => {
        const dir = join(home, ".bun", "bin");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "claude"), "not executable");
        chmodSync(join(dir, "claude"), 0o644);
        const usable = installClaudeAt(".local", "bin");

        expect(resolveClaudeBinaryForTeammates()).toBe(usable);
    });

    test("returns an absolute path whenever anything resolves at all", () => {
        const resolved = resolveClaudeBinaryForTeammates();

        expect(resolved.startsWith("/")).toBe(true);
        expect(resolved).not.toBe("claude");
    });

    /**
     * The last-resort branch, reachable only through the injected lookup:
     * `Bun.which("claude")` finds this repo's own
     * `node_modules/@anthropic-ai/claude-code` no matter what PATH says, so the
     * real candidate list can never come back empty from inside the repo.
     */
    test("falls back to the bare name when every candidate misses", () => {
        expect(resolveClaudeBinaryForTeammates(() => [])).toBe("claude");
    });

    test("falls back when candidates exist but none is executable", () => {
        const dir = join(home, "nope");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "claude"), "not executable");
        chmodSync(join(dir, "claude"), 0o644);

        expect(resolveClaudeBinaryForTeammates(() => [join(dir, "claude"), join(dir, "missing")])).toBe("claude");
    });

    test("the injected list is honoured in order", () => {
        const first = installClaudeAt("first", "bin");
        const second = installClaudeAt("second", "bin");

        expect(resolveClaudeBinaryForTeammates(() => [first, second])).toBe(first);
        expect(resolveClaudeBinaryForTeammates(() => [second, first])).toBe(second);
    });
});

describe("buildTeammateWrapperScript", () => {
    test("exports the OAuth env CC's spawn allowlist drops, then execs the real binary", () => {
        const script = buildTeammateWrapperScript({ claudeBin: "/Users/x/.bun/bin/claude", env: AUTH });

        expect(script).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-secret'");
        expect(script).toContain("export CLAUDE_CODE_SUBSCRIPTION_TYPE='max'");
        expect(script).toContain("export TOOLS_CLAUDE_ACCOUNT='max-primary'");
        expect(script.trimEnd().endsWith(`exec '/Users/x/.bun/bin/claude' "$@"`)).toBe(true);
    });

    /**
     * The script is why a shell function can never satisfy the bare-name fallback
     * above: non-interactive bash, no profile sourced, and it ends in `exec`, so
     * only a real executable on PATH resolves.
     */
    test("execs the resolved binary from a non-interactive shell that sources nothing", () => {
        const script = buildTeammateWrapperScript({ claudeBin: "/usr/local/bin/claude", env: AUTH });

        expect(script).toContain("#!/usr/bin/env bash");
        expect(script).toContain("set -euo pipefail");
        expect(script).not.toContain("source ");
        expect(script).not.toContain("bash -l");
    });

    test("single quotes in a value cannot break out of the export", () => {
        const script = buildTeammateWrapperScript({
            claudeBin: "/bin/claude",
            env: { ...AUTH, accountName: "it's mine" },
        });

        expect(script).toContain(`export TOOLS_CLAUDE_ACCOUNT='it'\\''s mine'`);
    });

    test("a token carrying shell metacharacters cannot break out either", () => {
        const script = buildTeammateWrapperScript({
            claudeBin: "/usr/local/bin/claude",
            env: { ...AUTH, oauthToken: "tok'; rm -rf /; echo '" },
        });

        expect(script).toContain(`export CLAUDE_CODE_OAUTH_TOKEN=${shellSingleQuote("tok'; rm -rf /; echo '")}`);
        expect(script).not.toContain("rm -rf /; echo ''\n");
    });

    test("optional Fable model knobs are omitted when unset", () => {
        const script = buildTeammateWrapperScript({ claudeBin: "/bin/claude", env: AUTH });

        expect(script).not.toContain("ANTHROPIC_DEFAULT_FABLE_MODEL");
        expect(script).not.toContain("ANTHROPIC_CUSTOM_MODEL_OPTION");
    });
});

describe("installTeammateWrapper / removeTeammateWrapper", () => {
    test("writes an executable wrapper readable only by the owner", () => {
        const dir = freshDir();
        const { path } = installTeammateWrapper({ dir, id: "fixed", claudeBin: "/bin/claude", env: AUTH });

        expect(path).toBe(join(dir, "wrapper-fixed.sh"));
        expect(existsSync(path)).toBe(true);
        accessSync(path, constants.X_OK);
        // The file holds the OAuth token in plaintext — group/other must see nothing.
        expect(statSync(path).mode & 0o077).toBe(0);
    });

    test("a wrapper dir inherited with a loose mode is tightened before the token is written", () => {
        const dir = freshDir();
        chmodSync(dir, 0o755);

        installTeammateWrapper({ dir, id: "tighten", claudeBin: "/bin/claude", env: AUTH });

        expect(statSync(dir).mode & 0o077).toBe(0);
    });

    test("refuses to write the token into a pre-created file, whose mode would be its own", () => {
        const dir = freshDir();
        const squatted = join(dir, "wrapper-squat.sh");
        writeFileSync(squatted, "", { mode: 0o666 });

        expect(() => installTeammateWrapper({ dir, id: "squat", claudeBin: "/bin/claude", env: AUTH })).toThrow();
        // The token never reached the file the attacker could read.
        expect(readFileSync(squatted, "utf8")).toBe("");
    });

    test("remove unlinks the token file, and tolerates unknown/undefined paths", () => {
        const dir = freshDir();
        const { path } = installTeammateWrapper({ dir, id: "gone", claudeBin: "/bin/claude", env: AUTH });

        removeTeammateWrapper(path);
        expect(existsSync(path)).toBe(false);

        expect(() => removeTeammateWrapper(path)).not.toThrow();
        expect(() => removeTeammateWrapper(undefined)).not.toThrow();
    });
});

describe("sweepStaleTeammateWrappers", () => {
    test("drops wrappers past the age bound and keeps fresh ones", () => {
        const dir = freshDir();
        const stale = installTeammateWrapper({ dir, id: "stale", claudeBin: "/bin/claude", env: AUTH }).path;
        const fresh = installTeammateWrapper({ dir, id: "fresh", claudeBin: "/bin/claude", env: AUTH }).path;

        const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        utimesSync(stale, longAgo, longAgo);

        expect(sweepStaleTeammateWrappers(7 * 24 * 60 * 60 * 1000, dir)).toBe(1);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
    });

    test("never touches files it did not create", () => {
        const dir = freshDir();
        const foreign = join(dir, "notes.txt");
        writeFileSync(foreign, "keep me");
        const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        utimesSync(foreign, longAgo, longAgo);

        expect(sweepStaleTeammateWrappers(1, dir)).toBe(0);
        expect(readdirSync(dir)).toEqual(["notes.txt"]);
    });

    test("a missing wrapper dir is not an error", () => {
        expect(sweepStaleTeammateWrappers(1, join(freshDir(), "never-created"))).toBe(0);
    });
});
