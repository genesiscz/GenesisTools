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

/** Background escape sequences: the band of a changed row and the brighter band of its changed words. */
export interface Palette {
    added: string;
    removed: string;
    addedWord: string;
    removedWord: string;
}

type FixedTheme = Exclude<DiffThemeName, "claude" | "classic">;

function rgb(red: number, green: number, blue: number): string {
    return `\u001b[48;2;${red};${green};${blue}m`;
}

const ANSI: Palette = {
    added: "\u001b[42m",
    removed: "\u001b[41m",
    addedWord: "\u001b[102m",
    removedWord: "\u001b[101m",
};

/**
 * `diffAdded`, `diffRemoved`, `diffAddedWord` and `diffRemovedWord` of each Claude Code theme, read
 * from the 2.1.296 binary on 2026-10-14. Each set was matched to its theme by the colours beside
 * it (the orange `claude` colour marks the daltonized pair, the dark `bashBorder` the dark one).
 */
const PALETTES: Record<FixedTheme, Palette> = {
    "claude-dark": {
        added: rgb(34, 92, 43),
        removed: rgb(122, 41, 54),
        addedWord: rgb(56, 166, 96),
        removedWord: rgb(179, 89, 107),
    },
    "claude-light": {
        added: rgb(105, 219, 124),
        removed: rgb(255, 168, 180),
        addedWord: rgb(47, 157, 68),
        removedWord: rgb(209, 69, 75),
    },
    "claude-dark-daltonized": {
        added: rgb(0, 68, 102),
        removed: rgb(102, 0, 0),
        addedWord: rgb(0, 119, 179),
        removedWord: rgb(179, 0, 0),
    },
    "claude-light-daltonized": {
        added: rgb(153, 204, 255),
        removed: rgb(255, 204, 204),
        addedWord: rgb(51, 102, 204),
        removedWord: rgb(153, 51, 51),
    },
    "claude-dark-ansi": ANSI,
    "claude-light-ansi": ANSI,
};

function isFixedTheme(name: string): name is FixedTheme {
    return Object.hasOwn(PALETTES, name);
}

/** Claude Code's `theme` setting (`dark`, `light-daltonized`, …), or `undefined` when unset or unreadable. */
function claudeCodeTheme(): string | undefined {
    const dir = env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude");

    try {
        const settings: unknown = SafeJSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

        if (typeof settings === "object" && settings !== null && "theme" in settings) {
            return typeof settings.theme === "string" ? settings.theme : undefined;
        }
    } catch {
        // No settings file, or one being rewritten this instant: the dark palette is the default.
    }

    return undefined;
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
