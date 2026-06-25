import { describe, expect, test } from "bun:test";
import { env } from "@app/utils/env";
import { buildTerminalSpawnEnv, resolveUtf8Locale } from "@app/utils/terminal/locale";

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
});
