import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * How a diff block looks. Every `claude*` theme copies Claude Code's own Bash diff: a full-width
 * band per changed row, syntax colour on top of it, and brighter bands on the changed words.
 * `claude` follows the `theme` the user picked in Claude Code; `classic` is this hook's original
 * look, kept byte for byte.
 */
export const DIFF_THEMES = [
    "claude",
    "claude-dark",
    "claude-light",
    "claude-dark-daltonized",
    "claude-light-daltonized",
    "claude-dark-ansi",
    "claude-light-ansi",
    "classic",
] as const;

export type DiffThemeName = (typeof DIFF_THEMES)[number];

export interface Palette {
    /** Background of a changed row; `""` leaves the row without a band (the ansi themes). */
    added: string;
    removed: string;
    /** Background of the changed words inside a row. */
    addedWord: string;
    removedWord: string;
    /** Foreground of the `+` and `-` markers. */
    addedMark: string;
    removedMark: string;
    /** A light palette, so the syntax colour has to come from a light `bat` theme. */
    light: boolean;
}

type FixedTheme = Exclude<DiffThemeName, "claude" | "classic">;

function background(red: number, green: number, blue: number): string {
    return `\u001b[48;2;${red};${green};${blue}m`;
}

function foreground(red: number, green: number, blue: number): string {
    return `\u001b[38;2;${red};${green};${blue}m`;
}

/**
 * The colours of Claude Code's own structured diff, from its diff module in the 2.1.296 binary
 * (`addLine`, `addWord`, `addDecoration` and the `delete*` three, truecolor), read on 2026-10-14.
 *
 * 🛑 NOT the theme's `diffAdded` / `diffRemoved` (`rgb(34,92,43)` in dark): those only override a
 * custom theme. The first cut used them, and the bands came out bright where Claude Code's are near
 * black: its added row measured `rgb(3,37,3)` on screen against `addLine` `rgb(2,40,0)`.
 */
const DARK_REMOVED = {
    removed: background(61, 1, 0),
    removedWord: background(92, 2, 0),
    removedMark: foreground(220, 90, 90),
};
const LIGHT_REMOVED = {
    removed: background(255, 220, 220),
    removedWord: background(255, 199, 199),
    removedMark: foreground(207, 34, 46),
};
/** The ansi themes band nothing: Claude Code colours only the markers there (ANSI 10 and 9). */
const ANSI: Palette = {
    added: "",
    removed: "",
    addedWord: "",
    removedWord: "",
    addedMark: "\u001b[92m",
    removedMark: "\u001b[91m",
    light: false,
};

const PALETTES: Record<FixedTheme, Palette> = {
    "claude-dark": {
        added: background(2, 40, 0),
        addedWord: background(4, 71, 0),
        addedMark: foreground(80, 200, 80),
        ...DARK_REMOVED,
        light: false,
    },
    "claude-dark-daltonized": {
        added: background(0, 27, 41),
        addedWord: background(0, 48, 71),
        addedMark: foreground(81, 160, 200),
        ...DARK_REMOVED,
        light: false,
    },
    "claude-light": {
        added: background(220, 255, 220),
        addedWord: background(178, 255, 178),
        addedMark: foreground(36, 138, 61),
        ...LIGHT_REMOVED,
        light: true,
    },
    "claude-light-daltonized": {
        added: background(219, 237, 255),
        addedWord: background(179, 217, 255),
        addedMark: foreground(36, 87, 138),
        ...LIGHT_REMOVED,
        light: true,
    },
    "claude-dark-ansi": ANSI,
    "claude-light-ansi": { ...ANSI, light: true },
};

function isFixedTheme(name: string): name is FixedTheme {
    return Object.hasOwn(PALETTES, name);
}

/**
 * A `theme` string from one Claude config file. `found` is false when the file is missing, unreadable,
 * or has no `theme` key. A key that is present but not a string is found and unset, so a later file
 * cannot override it.
 */
function themeIn(path: string): { found: true; theme: string | undefined } | { found: false } {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (typeof parsed !== "object" || parsed === null || !("theme" in parsed)) {
            return { found: false };
        }

        const theme = parsed.theme;

        return { found: true, theme: typeof theme === "string" ? theme : undefined };
    } catch {
        // Missing, or being rewritten this instant: the caller tries the next file.
        return { found: false };
    }
}

/**
 * Claude Code's `theme` (`dark`, `light-daltonized`, …), or `undefined` when unset.
 * `settings.json` wins. The legacy `~/.claude.json` (or `<CLAUDE_CONFIG_DIR>/.claude.json`) applies
 * only when that file has no `theme` key or cannot be read, which is what 2.1.296 `resolveSetting`
 * does for a user-intent key. A `theme` that is present but not a string does not fall through.
 */
function claudeCodeTheme(): string | undefined {
    const configDir = env.paths.getClaudeConfigDir();
    const settings = themeIn(join(configDir ?? join(homedir(), ".claude"), "settings.json"));

    if (settings.found) {
        return settings.theme;
    }

    const legacy = themeIn(join(configDir ?? homedir(), ".claude.json"));

    return legacy.found ? legacy.theme : undefined;
}

/** The palette a theme paints with, or `null` for `classic`. An unknown Claude theme reads as dark. */
export function resolvePalette(
    name: DiffThemeName,
    readTheme: () => string | undefined = claudeCodeTheme
): Palette | null {
    if (name === "classic") {
        return null;
    }

    if (name !== "claude") {
        return PALETTES[name];
    }

    const key = `claude-${readTheme() ?? "dark"}`;

    return isFixedTheme(key) ? PALETTES[key] : PALETTES["claude-dark"];
}
