import { execSync } from "node:child_process";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";

const UTF8_PATTERN = /utf-?8/i;

function envHasUtf8(value: string | undefined): value is string {
    return Boolean(value && UTF8_PATTERN.test(value));
}

let appleLocaleBaseCache: { value: string | undefined } | undefined;

function readAppleLocaleBase(): string | undefined {
    if (appleLocaleBaseCache) {
        return appleLocaleBaseCache.value;
    }

    const value = probeAppleLocaleBase();
    appleLocaleBaseCache = { value };
    return value;
}

function probeAppleLocaleBase(): string | undefined {
    if (process.platform !== "darwin") {
        return undefined;
    }

    try {
        const raw = execSync("defaults read NSGlobalDomain AppleLocale", {
            encoding: "utf-8",
            timeout: 1000,
        }).trim();

        return raw.split("@")[0]?.replace(/_/g, "-");
    } catch (error) {
        logger.debug({ error, command: "defaults read NSGlobalDomain AppleLocale" }, "Unable to read Apple locale");
        return undefined;
    }
}

export function resolveUtf8Locale(): string {
    for (const key of ["LC_ALL", "LANG", "LC_CTYPE"] as const) {
        const value = env.get(key);

        if (envHasUtf8(value)) {
            return value;
        }
    }

    const appleLocale = readAppleLocaleBase();

    if (appleLocale?.startsWith("cs")) {
        return "cs_CZ.UTF-8";
    }

    if (appleLocale) {
        const normalized = appleLocale.replace(/-/g, "_");
        return `${normalized}.UTF-8`;
    }

    return "en_US.UTF-8";
}

export function buildTerminalSpawnEnv(base: NodeJS.ProcessEnv = env.getProcessEnv()): NodeJS.ProcessEnv {
    const locale = resolveUtf8Locale();

    // NO_COLOR (no-color.org) forces chalk/supports-color to level 0 and overrides
    // everything else. Some parents (Claude Code subprocess paths, captured tmux
    // server globals) set it to keep ANSI out of captured output — but for a
    // terminal we OWN it's poison. Strip it so the child app can decide.
    const childEnv: NodeJS.ProcessEnv = { ...base };
    delete childEnv.NO_COLOR;

    return {
        ...childEnv,
        LANG: locale,
        LC_ALL: locale,
        LC_CTYPE: locale,
        // `||` (not `??`) so an inherited empty string `""` is replaced — `??`
        // only catches null/undefined and would silently keep the empty value.
        COLORTERM: base.COLORTERM || "truecolor",
        // Claude Code clamps to 256-color whenever $TMUX is set unless this is
        // present at process launch (settings.json is too late — module load time).
        CLAUDE_CODE_TMUX_TRUECOLOR: base.CLAUDE_CODE_TMUX_TRUECOLOR || "1",
    };
}

export function terminalLocaleEnvRecord(): Record<string, string> {
    const locale = resolveUtf8Locale();

    return {
        LANG: locale,
        LC_ALL: locale,
        LC_CTYPE: locale,
    };
}

export function localeExportPrefix(): string {
    const locale = resolveUtf8Locale();

    return `export LANG=${shellQuote(locale)} LC_ALL=${shellQuote(locale)} LC_CTYPE=${shellQuote(locale)}; `;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
