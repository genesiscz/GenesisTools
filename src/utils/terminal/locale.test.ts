import { describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { buildTerminalSpawnEnv, resolveUtf8Locale, stripTestSandboxEnv } from "@genesiscz/utils/terminal/locale";

describe("terminal locale", () => {
    test("resolveUtf8Locale keeps an existing UTF-8 LANG", () => {
        const saved = {
            LANG: env.locale.getLang(),
            LC_ALL: env.locale.getLcAll(),
            LC_CTYPE: env.locale.getLcCtype(),
        };

        env.testing.set("LANG", "cs_CZ.UTF-8");
        env.testing.unset("LC_ALL");
        env.testing.unset("LC_CTYPE");

        try {
            expect(resolveUtf8Locale()).toBe("cs_CZ.UTF-8");
        } finally {
            if (saved.LANG === undefined) {
                env.testing.unset("LANG");
            } else {
                env.testing.set("LANG", saved.LANG);
            }

            if (saved.LC_ALL === undefined) {
                env.testing.unset("LC_ALL");
            } else {
                env.testing.set("LC_ALL", saved.LC_ALL);
            }

            if (saved.LC_CTYPE === undefined) {
                env.testing.unset("LC_CTYPE");
            } else {
                env.testing.set("LC_CTYPE", saved.LC_CTYPE);
            }
        }
    });

    test("buildTerminalSpawnEnv sets LANG/LC_ALL/LC_CTYPE", () => {
        const env = buildTerminalSpawnEnv({ PATH: "/bin" });

        expect(env.PATH).toBe("/bin");
        expect(env.LANG).toBe(env.LC_ALL);
        expect(env.LANG).toBe(env.LC_CTYPE);
        expect(env.LANG).toMatch(/UTF-8/i);
    });

    test("buildTerminalSpawnEnv sets truecolor + Claude tmux override when unset", () => {
        const env = buildTerminalSpawnEnv({ PATH: "/bin" });

        expect(env.COLORTERM).toBe("truecolor");
        expect(env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
    });

    test("buildTerminalSpawnEnv preserves explicit COLORTERM and Claude override", () => {
        const env = buildTerminalSpawnEnv({
            PATH: "/bin",
            COLORTERM: "24bit",
            CLAUDE_CODE_TMUX_TRUECOLOR: "0",
        });

        expect(env.COLORTERM).toBe("24bit");
        expect(env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("0");
    });

    test("buildTerminalSpawnEnv drops a test sandbox home from the child env", () => {
        const spawned = buildTerminalSpawnEnv({
            PATH: "/bin",
            GENESIS_TOOLS_HOME: "/tmp/gt-test-tmp-abc/gt-test-home-xyz",
            GENESIS_TEST_TMP_ROOT: "/tmp/gt-test-tmp-abc",
            TMPDIR: "/tmp/gt-test-tmp-abc",
            NODE_ENV: "test",
        });

        expect(spawned.GENESIS_TOOLS_HOME).toBeUndefined();
        expect(spawned.GENESIS_TEST_TMP_ROOT).toBeUndefined();
        expect(spawned.TMPDIR).toBeUndefined();
        expect(spawned.NODE_ENV).toBeUndefined();
        expect(spawned.PATH).toBe("/bin");
    });

    test("buildTerminalSpawnEnv keeps a real TMPDIR and a non-test NODE_ENV", () => {
        const spawned = buildTerminalSpawnEnv({
            PATH: "/bin",
            TMPDIR: "/var/folders/6w/T/",
            NODE_ENV: "development",
        });

        expect(spawned.TMPDIR).toBe("/var/folders/6w/T/");
        expect(spawned.NODE_ENV).toBe("development");
    });

    test("stripTestSandboxEnv keeps a GENESIS_TOOLS_HOME that no test set", () => {
        expect(stripTestSandboxEnv({ GENESIS_TOOLS_HOME: "/work/sandbox" }).GENESIS_TOOLS_HOME).toBe("/work/sandbox");
    });

    test("stripTestSandboxEnv still drops a test home recognised by its name alone", () => {
        // A tmux server founded by an older suite carries the home but no temp-root marker.
        expect(
            stripTestSandboxEnv({ GENESIS_TOOLS_HOME: "/tmp/gt-test-home-a1b2" }).GENESIS_TOOLS_HOME
        ).toBeUndefined();
    });

    test("stripTestSandboxEnv leaves a TMPDIR outside the sandbox root alone", () => {
        const stripped = stripTestSandboxEnv({
            GENESIS_TEST_TMP_ROOT: "/tmp/gt-test-tmp-abc",
            TMPDIR: "/var/folders/6w/T/",
        });

        expect(stripped.TMPDIR).toBe("/var/folders/6w/T/");
        expect(stripped.GENESIS_TEST_TMP_ROOT).toBeUndefined();
    });

    test("stripTestSandboxEnv leaves a SIBLING of the sandbox root alone", () => {
        // A bare `startsWith` also matches this path, and deleting its TMPDIR would break a
        // sandbox that never belonged to this run.
        const stripped = stripTestSandboxEnv({
            GENESIS_TEST_TMP_ROOT: "/tmp/gt-test-tmp-abc",
            TMPDIR: "/tmp/gt-test-tmp-abc-user",
        });

        expect(stripped.TMPDIR).toBe("/tmp/gt-test-tmp-abc-user");
    });

    test("stripTestSandboxEnv still removes a TMPDIR nested inside the sandbox root", () => {
        const stripped = stripTestSandboxEnv({
            GENESIS_TEST_TMP_ROOT: "/tmp/gt-test-tmp-abc",
            TMPDIR: "/tmp/gt-test-tmp-abc/nested/deeper",
        });

        expect(stripped.TMPDIR).toBeUndefined();
    });

    test("stripTestSandboxEnv tolerates a trailing separator on either side", () => {
        const stripped = stripTestSandboxEnv({
            GENESIS_TEST_TMP_ROOT: "/tmp/gt-test-tmp-abc/",
            TMPDIR: "/tmp/gt-test-tmp-abc",
        });

        expect(stripped.TMPDIR).toBeUndefined();
    });
});
