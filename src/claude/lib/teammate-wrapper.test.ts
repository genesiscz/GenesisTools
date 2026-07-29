import { describe, expect, test } from "bun:test";
import {
    accessSync,
    constants,
    existsSync,
    mkdtempSync,
    readdirSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildTeammateWrapperScript,
    installTeammateWrapper,
    removeTeammateWrapper,
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

describe("buildTeammateWrapperScript", () => {
    test("exports the OAuth env CC's spawn allowlist drops, then execs the real binary", () => {
        const script = buildTeammateWrapperScript({ claudeBin: "/Users/x/.bun/bin/claude", env: AUTH });

        expect(script).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-secret'");
        expect(script).toContain("export CLAUDE_CODE_SUBSCRIPTION_TYPE='max'");
        expect(script).toContain("export TOOLS_CLAUDE_ACCOUNT='max-primary'");
        expect(script.trimEnd().endsWith(`exec '/Users/x/.bun/bin/claude' "$@"`)).toBe(true);
    });

    test("single quotes in a value cannot break out of the export", () => {
        const script = buildTeammateWrapperScript({
            claudeBin: "/bin/claude",
            env: { ...AUTH, accountName: "it's mine" },
        });

        expect(script).toContain(`export TOOLS_CLAUDE_ACCOUNT='it'\\''s mine'`);
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
