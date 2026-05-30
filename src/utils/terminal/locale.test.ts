import { describe, expect, test } from "bun:test";
import { buildTerminalSpawnEnv, resolveUtf8Locale } from "@app/utils/terminal/locale";

describe("terminal locale", () => {
    test("resolveUtf8Locale keeps an existing UTF-8 LANG", () => {
        const saved = {
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            LC_CTYPE: process.env.LC_CTYPE,
        };

        process.env.LANG = "cs_CZ.UTF-8";
        delete process.env.LC_ALL;
        delete process.env.LC_CTYPE;

        try {
            expect(resolveUtf8Locale()).toBe("cs_CZ.UTF-8");
        } finally {
            if (saved.LANG === undefined) {
                delete process.env.LANG;
            } else {
                process.env.LANG = saved.LANG;
            }

            if (saved.LC_ALL === undefined) {
                delete process.env.LC_ALL;
            } else {
                process.env.LC_ALL = saved.LC_ALL;
            }

            if (saved.LC_CTYPE === undefined) {
                delete process.env.LC_CTYPE;
            } else {
                process.env.LC_CTYPE = saved.LC_CTYPE;
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
});
