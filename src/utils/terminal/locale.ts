import { execSync } from "node:child_process";

const UTF8_PATTERN = /utf-?8/i;

function envHasUtf8(value: string | undefined): value is string {
    return Boolean(value && UTF8_PATTERN.test(value));
}

function readAppleLocaleBase(): string | undefined {
    if (process.platform !== "darwin") {
        return undefined;
    }

    try {
        const raw = execSync("defaults read NSGlobalDomain AppleLocale", {
            encoding: "utf-8",
            timeout: 1000,
        }).trim();

        return raw.split("@")[0]?.replace(/_/g, "-");
    } catch {
        return undefined;
    }
}

export function resolveUtf8Locale(): string {
    for (const key of ["LC_ALL", "LANG", "LC_CTYPE"] as const) {
        const value = process.env[key];

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

export function buildTerminalSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const locale = resolveUtf8Locale();

    return {
        ...base,
        LANG: locale,
        LC_ALL: locale,
        LC_CTYPE: locale,
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
